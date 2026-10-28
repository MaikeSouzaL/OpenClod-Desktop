# Open Interpreter (Codex CLI fork)

| Campo | Valor |
|---|---|
| Repositório | https://github.com/OpenInterpreter/open-interpreter |
| Clone local | `repositorios/_research/agents/OpenInterpreter--open-interpreter` |
| Commit | `ac1fcc8fe57aba51fcc3c79afd57a0883237fe87` |
| Licença | Apache-2.0 (`LICENSE:1`); `NOTICE:1-3` atribui o código derivado a "OpenAI Codex, Copyright 2025 OpenAI" |
| Categoria | agents (CLI de código, sandbox e aprovação) |
| Stack | Rust (workspace Cargo + Bazel) + TUI `ratatui` + `tokio`; Node apenas para distribuição (`package.json`, `pnpm-workspace.yaml`) |
| Tamanho | 4.796 arquivos `.rs` e ~1,79 milhão de linhas em `codex-rs/`; 1.184 arquivos `*_tests.rs`; 8.683 arquivos no clone |

## 1. O que é (verificado no código)

O README mudou de produto: hoje este clone é um **fork do OpenAI Codex CLI
reescrito/estendido em Rust**, com marca própria (`product-info/src/lib.rs:2-3`
define `OPEN_INTERPRETER_DISPLAY_NAME = "Open Interpreter"` e
`OPEN_INTERPRETER_COMMAND_NAME = "interpreter"`). O README descreve a
reimplementação do harness Kimi Code e aponta para o Codex
(`README.md:15-19`); o código confirma: `codex-rs/` é um workspace Cargo com
~120 crates (`codex-rs/Cargo.toml:1-60`), incluindo `core`, `exec`, `tui`,
`app-server`, `mcp-server`, `sandboxing`, `execpolicy`, `apply-patch` e
`rollout`.

O entrypoint é `codex-rs/cli/src/main.rs` (`[[bin]] name = "codex"` em
`cli/Cargo.toml:9-11`), com subcomandos que vão de `exec` a `resume`, `fork`,
`sandbox` e `mcp-server` (`cli/src/main.rs:152-246`). O loop real está em
`core/src/session/turn.rs:163` (`run_turn`), não em `codex.rs` como no upstream
antigo. Não há Python: a parte "Open Interpreter" histórica não existe mais
neste commit.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `interpreter` | `product-info/src/lib.rs:2-3` | nome do comando do produto; binário `codex` |
| `interpreter exec` / `e` | `cli/src/main.rs:160-162` | execução não interativa |
| `interpreter review` | `cli/src/main.rs:164-165` | code review não interativo |
| `interpreter login` / `logout` | `cli/src/main.rs:167-171` | auth (API key, ChatGPT, device code) |
| `interpreter mcp` / `mcp-server` | `cli/src/main.rs:173-180` | gerencia MCP e roda como servidor MCP |
| `interpreter acp` | `cli/src/main.rs:182-183` | agente via Agent Client Protocol |
| `interpreter app-server` | `cli/src/main.rs:184-185` | servidor JSON-RPC para a UI |
| `interpreter apply` / `a` | `cli/src/main.rs:217-219` | aplica o último diff como `git apply` |
| `interpreter resume` | `cli/src/main.rs:221-222` | retoma sessão (picker ou `--last`) |
| `interpreter fork` | `cli/src/main.rs:236-237` | bifurca sessão anterior |
| `interpreter queue` | `cli/src/main.rs:224-225` | enfileira mensagem numa sessão viva |
| `interpreter archive` / `delete` / `unarchive` | `cli/src/main.rs:227-234` | ciclo de vida de sessão |
| `interpreter sandbox` | `cli/src/main.rs:207-208` | roda comando dentro do sandbox do agente |
| `interpreter doctor` / `update` / `completion` | `cli/src/main.rs:194-205` | diagnóstico/instalação |
| `interpreter execpolicy` | `cli/src/main.rs:213-215` | CLI do motor de políticas (oculto) |
| `codex-rs/justfile` | `codex-rs/justfile` | atalhos de build/test do workspace |

Slash commands e atalhos de TUI não foram mapeados nesta leitura; a superfície
principal é o CLI acima e o `app-server` (`codex-rs/app-server/src`).

## 3. Arquitetura e fluxo

```
cli/main.rs → core::CodexThread.submit(Op) → session loop
  → run_turn (turn.rs) → pre-compact → capture_step_context
  → model_client.stream (SSE/WS) → tool calls → registry/router
  → sandbox + approval → output → history → rollout JSONL
```

- Entry point: `codex-rs/cli/src/main.rs:152-246`.
- Loop do agente: `codex-rs/core/src/session/turn.rs:163` (`run_turn`);
  laço em `:423-537`.
- Execução de ferramenta: `core/src/tools/registry.rs` (dispatch) +
  `core/src/tools/router.rs`; handlers em `core/src/tools/handlers/`.
- Streaming: `core/src/client.rs:1649-1666` (Responses API SSE),
  `:1827-1848` (WebSocket), `:2277-2294` (Chat Completions compat).
- Persistência: `codex-rs/rollout/src/lib.rs:1-97` (JSONL append-only).

## 4. Catálogo de ferramentas / capacidades

Registro em `core/src/tools/handlers/mod.rs:1-45`, exportado em `:66-97`.
Ferramentas são `ToolSpec` com JSON Schema **ou** freeform com gramática
(`core/src/tools/handlers/apply_patch_spec.rs:1-28`).

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `apply_patch` (freeform, Lark) | `core/assets/tools/apply_patch.lark:1-19`; `apply_patch_spec.rs:9-28` | add/delete/update/move por hunks com `@@` | médio |
| `exec_command` | `handlers/unified_exec.rs:27-50` | roda shell com `tty`, `yield_time_ms`, `timeout_ms`, `max_output_tokens`, permissões | alto |
| `write_stdin` | `handlers/unified_exec.rs:20-25` | escreve em processo vivo (sessão persistente) | alto |
| `plan` | `handlers/plan.rs`, `plan_spec.rs` | plano estruturado do turno | baixo |
| `request_user_input` (sync/async) | `handlers/request_user_input.rs:33-34` | pergunta ao usuário no meio do turno | baixo |
| `request_permissions` | `handlers/request_permissions.rs:30` | pede elevação de permissão | alto |
| `spawn_agent` / multi-agentes | `handlers/multi_agents_spec.rs:14-21` | subagentes com fork de histórico e override de modelo | alto |
| `tool_search` | `handlers/tool_search.rs:41-42` | descobre ferramentas sob demanda | baixo |
| `view_image` | `handlers/view_image.rs:44-45` | imagem no contexto | baixo |
| `get_context_remaining` | `handlers/get_context_remaining.rs:6` | orçamento de contexto visível ao modelo | baixo |
| `new_context_window` | `handlers/new_context_window.rs` | abre janela de contexto nova | médio |
| MCP tool calls | `handlers/mcp.rs`, `core/src/mcp_tool_call.rs` | ferramentas de servidores MCP | alto |
| shell do usuário | `core/src/user_shell_command.rs` | comando iniciado pelo humano (`!`) | alto |

## 5. Loop do agente, contexto e streaming

`run_turn` faz, em ordem: hooks pendentes, compactação pré-amostragem
(`turn.rs:183-222`), captura do `step_context` (`:257-280`), registro do
`world_state` (`:282-290`), e então o laço (`:423`). Dentro do laço:

1. **Steering**: drena input pendente do usuário antes de cada passo e o
   registra como `SteeredUserInput` (`:427-446`). É o que permite o usuário
   mandar mensagem sem parar o turno.
2. Recomputa MCPs exigidos por menções (`:470-495`).
3. Monta o input do modelo a partir do histórico já filtrado por modalidade
   (`:513-519`).
4. Chama `run_sampling_request`, que consome o stream e despacha tool calls
   (`:524-535`; `core/src/stream_events_utils.rs`).
5. Resultado: itens de resposta viram eventos e o laço continua até não haver
   tool call (`:537+`).

Contexto: `session/context_window.rs:8-19` calcula tokens ativos, tokens do
escopo de auto-compact e limites; `compact.rs:62` limita a mensagem de
compactação a 20 000 tokens e usa `SUMMARIZATION_PROMPT`
(`compact.rs:58`). Há hooks `pre_compact`/`post_compact`
(`compact.rs:11-14`) e estratégias remotas v2 (`compact_remote_v2.rs`).

Cancelamento é por `CancellationToken` propagado a cada passo
(`turn.rs:169`, `:532`); retry de stream fica em `responses_retry.rs`
(`turn.rs:33-35`). Custo/tokens são registrados por turno
(`state/turn_token_usage.rs`).

## 6. Sessões, estado e persistência

Sessão = *rollout* JSONL append-only (`rollout/src/lib.rs:1`,
`:50-97`), com parsing robusto linha a linha e scanner reverso
(`reverse_jsonl_scanner.rs`) para ler o fim sem carregar tudo. `resume` e
`fork` são subcomandos de primeira classe (`cli/src/main.rs:221-237`), e há
`archive`/`delete`/`unarchive` (`:227-234`). O histórico é reconstruído por
`session/rollout_reconstruction.rs`; a compressão de rollout fica em
`rollout/src/compression.rs`.

Além do transcript, o turno mantém um `TurnDiffTracker`: diff líquido do turno
calculado a partir dos `apply_patch` aplicados, **sem reler o workspace**, com
cache por revisão e timeout de 100 ms para entradas patológicas
(`core/src/turn_diff_tracker.rs:15-17`, `:47-60`). É o que alimenta "changes
deste turno" sem custo de I/O.

## 7. Configuração e extensibilidade

- Config em camadas TOML (`codex-rs/config` + `config-schema`), com merge por
  precedência (`agents_md.rs:20-26` importa `ConfigLayerSource`,
  `merge_toml_values`).
- Instruções de projeto: `AGENTS.md` do root até o cwd, concatenados, com
  `AGENTS.override.md` local e separador explícito
  (`core/src/agents_md.rs:1-18`, `:43-49`).
- Skills: crate `skills` + `core/src/skills.rs`; plugins: `plugin` +
  `core/src/plugins`; hooks: crate `hooks` com regras declarativas
  (`hooks/src/registry.rs`, `schema.rs`).
- MCP: `codex-mcp`, `mcp-server`, `rmcp-client`, e políticas por ambiente
  (`core/src/mcp_tool_approval_templates.rs`).
- Multi-agente: `agent-roles` (descoberta/loader de papéis,
  `agent-roles/src/{discovery,loader}.rs`) e `multi_agents_spec.rs:14-21`.
- Memórias: crate `memories` + `core/src/client.rs:748` (`summarize_memories`).

## 8. Permissões, sandbox e erros

Três camadas independentes, todas verificadas no código:

1. **Política de execução** declarativa em Starlark:
   `prefix_rule(pattern, decision, justification, match, not_match)`
   (`execpolicy/README.md:3-15`), com decisões `allow | prompt | forbidden`
   (`execpolicy/src/decision.rs:9-16`). `match`/`not_match` são testes
   executados no load — regra inválida não entra.
2. **Safety check** de patch: `AutoApprove | AskUser | Reject`
   (`core/src/safety.rs:16-21`); auto-aprova só quando o patch está contido
   nos writable roots **e** há sandbox disponível; caso contrário pergunta ou
   rejeita com motivo (`:29-85`).
3. **Sandbox de SO**: `seatbelt` (macOS), `landlock` e `bwrap` (Linux),
   `windows-sandbox` (Windows) em `codex-rs/sandboxing/src/`; o exec monta
   `SandboxTransformRequest` e escolhe `SandboxType`
   (`core/src/exec.rs:36-44`).

Aprovação tem `AskForApproval::{Never, OnRequest, UnlessTrusted, Granular}`
(`safety.rs:43-52`) e o pedido do modelo carrega `justification` e
`prefix_rule` para o usuário aprovar "sempre assim"
(`handlers/unified_exec.rs:43-49`). Há ainda um **guardian**: revisor síncrono
isolado, com orçamento próprio de requests (`core/src/guardian/mod.rs:1-2`,
`:51-55`; `request_budget.rs`).

Erros de sandbox são classificados (`is_likely_sandbox_denied`,
`exec.rs:44`) e viram evento, não crash. `doctor` diagnostica instalação
(`cli/src/main.rs:204-205`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Testes colocados | 1.184 arquivos `*_tests.rs` em `codex-rs/` | unidade por módulo, incluindo turno, sandbox, policy |
| Integração de policy | `codex-rs/execpolicy/tests/basic.rs` | avaliação de `prefix_rule` |
| Integração de core | `core/tests/` (por crate) | loop, MCP, compactação |
| Snapshot/insta | crates com `insta` | protocolo e eventos |
| Bazel | `MODULE.bazel`, `BUILD.bazel`, `bazel/` | build/teste herméticos |
| Lint | `codex-rs/clippy.toml`, `rustfmt.toml`, `deny.toml` | Clippy, fmt, licenças |
| CI | `.github/workflows/` | matriz de SO e sandbox |

O volume de testes é proporcional ao tamanho: ~1 teste por 4 arquivos de
código. Não é um projeto para portar inteiro, mas o desenho de cada camada é
documentado por teste.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Formato `apply_patch` + gramática | `core/assets/tools/apply_patch.lark:1-19`; `apply_patch_spec.rs:9-28` | edição multi-hunk determinística, sem diff frágil | Apache-2.0 | `src/core/tools/apply-patch/` | 24 |
| Política `prefix_rule` (allow/prompt/forbidden) | `execpolicy/README.md:3-15`; `decision.rs:9-16` | regras versionadas, com justificativa e testes embutidos | Apache-2.0 | `src/core/permissions/policy.ts` | 23 |
| SafetyCheck de patch por writable roots | `core/src/safety.rs:16-85` | decide autoaprovar/perguntar/rejeitar com motivo | Apache-2.0 | `src/core/permissions/patch-safety.ts` | 22 |
| TurnDiffTracker sem I/O | `core/src/turn_diff_tracker.rs:47-60` | diff do turno instantâneo e cacheado | Apache-2.0 | `src/core/patch/turn-diff.ts` | 21 |
| Rollout JSONL + resume/fork | `rollout/src/lib.rs:50-97`; `cli/src/main.rs:221-237` | retomada barata e auditável | Apache-2.0 | `src/core/session/rollout.ts` | 21 |
| Steering de input pendente | `core/src/session/turn.rs:423-446` | usuário corrige sem matar o turno | Apache-2.0 | `src/core/agent/steering.ts` | 20 |
| Aprovação com `prefix_rule` aprendida | `handlers/unified_exec.rs:43-49` | "permitir sempre este prefixo" vira regra | Apache-2.0 | `src/core/permissions/approval.ts` | 19 |
| AGENTS.md hierárquico | `core/src/agents_md.rs:1-18` | instruções por diretório sem colisão | Apache-2.0 | `src/core/context/project-docs.ts` | 18 |
| Auto-compact com orçamento explícito | `session/context_window.rs:8-19`; `compact.rs:58-62` | mede antes de decidir, separa escopo | Apache-2.0 | `src/core/context/window.ts` | 17 |
| Guardian reviewer isolado | `core/src/guardian/mod.rs:1-2` | segunda opinião com orçamento próprio | Apache-2.0 | `src/core/agent/guardian.ts` | 14 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| O workspace Rust inteiro (~1,79 M linhas, ~120 crates) | stack incompatível com Electron/TS; custo de manutenção absurdo |
| `app-server` JSON-RPC e a TUI `ratatui` | já temos UI React própria |
| Auth ChatGPT/OpenAI, cloud tasks, analytics/OTel | produto do fornecedor, não harness |
| Sandbox de SO (seatbelt/landlock/bwrap) | no desktop usamos permissões + processo filho; portar seria reescrever SO |
| `code-mode`/V8 e realtime WebRTC | experimentos, sem necessidade nossa |
| Nomes e branding "Kimi"/"Codex" | acoplamento a provedor |
| `execpolicy` como linguagem Starlark | portar o *modelo* (prefixo+justificativa), não o parser Starlark |
| 1.184 arquivos de teste | portar os casos de borda relevantes, não a suíte |

## 12. Modelo de exemplo para o nosso harness

O desenho que vale copiar é o **funil de escrita**:

1. Toda edição entra por um único `apply_patch` com gramática fechada
   (`*** Begin Patch` / `*** Update File` / `@@` / `+`/`-`/` ` / `*** End Patch`).
   Recusar patch vazio e patch que sai dos writable roots.
2. Antes de aplicar, classificar: `auto_approve` (dentro dos roots + sandbox),
   `ask_user` (fora, mas permitido) ou `reject` (read-only ou política
   `forbidden`), sempre com motivo textual — como `SafetyCheck`.
3. Política em arquivo versionado: `prefix_rule(pattern=["git","push"], decision="prompt",
   justification="...", match=[...], not_match=[...])`. Regras com exemplo
   inválido não carregam.
4. Um `TurnDiffTracker` que acumula o diff do turno a partir dos patches
   aplicados, sem reler disco, e expõe `unifiedDiff` para a UI e para o
   `git apply` posterior.
5. Sessão em JSONL append-only: cada linha é um evento (`item`, `turn`,
   `compaction`), com `resume(afterSeq)` e `fork(atEvent)`. Isso conversa
   diretamente com o cursor `seq` que já queremos no core.
6. Steering: fila de input lida entre passos do modelo, nunca no meio de uma
   tool call.

Teste: um caso por decisão de safety (auto/ask/reject), um patch com dois hunks
no mesmo arquivo, um `not_match` que precisa falhar no load, e um resume que
prova que o JSONL truncado no meio é rejeitado com erro claro.

## 13. Evidências da análise

```text
git rev-parse HEAD → ac1fcc8fe57aba51fcc3c79afd57a0883237fe87
codex-rs/*.rs → 4.796 arquivos, ~1.788.209 linhas; 1.184 *_tests.rs
NOTICE:1-3 → código derivado de OpenAI Codex (Apache-2.0)
product-info/src/lib.rs:2-3 → "Open Interpreter" / comando "interpreter"
cli/src/main.rs:152-246 → subcomandos (exec, review, mcp-server, apply, resume, fork, sandbox)
core/src/session/turn.rs:163 → run_turn; :423 laço; :427-446 steering
core/src/session/turn.rs:183-222 → compactação pré-amostragem
core/assets/tools/apply_patch.lark:1-19 → gramática do patch
core/src/tools/handlers/apply_patch_spec.rs:9-28 → tool freeform com Lark
core/src/tools/handlers/unified_exec.rs:27-50 → args de exec_command
core/src/safety.rs:16-85 → AutoApprove/AskUser/Reject
execpolicy/README.md:3-15 → prefix_rule + match/not_match
execpolicy/src/decision.rs:9-16 → allow/prompt/forbidden
core/src/turn_diff_tracker.rs:15-17,47-60 → diff do turno sem I/O
rollout/src/lib.rs:1,50-97 → JSONL append-only
core/src/agents_md.rs:1-18,43-49 → AGENTS.md hierárquico
core/src/guardian/mod.rs:1-2,51-55 → reviewer isolado
```
