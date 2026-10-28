# Cline

| Campo | Valor |
|---|---|
| Repositório | https://github.com/cline/cline (`git remote get-url origin`) |
| Clone local | `repositorios/_research/agents/cline--cline` |
| Commit | `40c5d99031fe1128189c5b52e40638d2b7787754` |
| Licença | Apache-2.0 (`LICENSE:1-2`) |
| Categoria | agents / SDK + extensão VS Code + CLI + desktop |
| Stack | TypeScript, Bun 1.4.2, Biome, Vitest, Commander (CLI), Tauri/Rust (desktop), protobuf/gRPC (webview VS Code) |
| Tamanho | 4.367 arquivos versionados; 3.880 fontes (~1,17 M linhas); 1.017 arquivos de teste (`apps` 637, `sdk` 377) |

## 1. O que é (verificado no código)

O Cline deixou de ser "uma extensão VS Code" e virou um monorepo com quatro produtos sobre um SDK
próprio. O núcleo do agente é **stateless** e vive em `sdk/packages/agents/src/agent-runtime.ts:533`
(`class AgentRuntime`); o estado (sessão, storage, config, ferramentas padrão, MCP) fica em
`sdk/packages/core/src/ClineCore.ts:101`. A extensão VS Code (`apps/vscode`) fala com esse núcleo por
gRPC/protobuf (`apps/vscode/proto/cline/*.proto`), o CLI (`apps/cli`) por Commander sobre o hub local,
e o desktop é um shell Tauri. A regra de dependência é explícita em `sdk/AGENTS.md`: `shared → llms →
agents → core → apps`, com `agents` proibido de conhecer sessão/storage. O README vende "AI coding
agent"; o código mostra um SDK reutilizável com loop, políticas de ferramenta, compactação e um
daemon de hub — a parte mais interessante para nós é o SDK, não a extensão.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `bun run cli` | `package.json:22` | CLI em dev (auto-spawna o hub) |
| `bun run cli doctor` | `apps/cli/src/main.ts:547-557` | diagnóstico de config/ambiente |
| `bun run cli auth` | `apps/cli/src/main.ts:198-244` | autentica provedor e escolhe modelo |
| `bun run cli config` | `apps/cli/src/main.ts:280-292` | mostra config efetiva |
| `bun run cli plugin install/uninstall` | `apps/cli/src/main.ts:294-364` | plugins do Cline |
| `bun run cli mcp install/uninstall` | `apps/cli/src/main.ts:474-535` | wizard/servidores MCP |
| `bun run cli skill` | `apps/cli/src/main.ts:366-384` | delega ao `npx skills` |
| `bun run cli connect` | `apps/cli/src/main.ts:388-472` | conecta a canal externo (Slack etc.) |
| `bun run cli hub` | `apps/cli/src/main.ts:612+` | controla o daemon compartilhado |
| `bun run cli history` | `apps/cli/src/commands/history.ts` | lista/retoma histórico |
| `bun run cli hook` | `apps/cli/src/main.ts:574-583` | processa payload de hook via stdin |
| `bun run cli schedule` | `apps/cli/src/main.ts:597-610` | tarefas agendadas (cron) |
| `bun run check` | `package.json:41` | Biome + build SDK + typecheck + publish check |

O entrypoint real do CLI é `apps/cli/src/main.ts` (Commander, ~39 KB), com `apps/cli/src/index.ts`
como shim. O modo interativo é uma TUI própria em `apps/cli/src/tui` (OpenTUI, conforme
`package.json` overrides `@opentui/*`). ACP (`apps/cli/src/acp`) permite que editores externos dirijam
o agente.

## 3. Arquitetura e fluxo

```
apps/cli | apps/vscode | apps/examples/desktop-app
  → ClineCore (sdk/packages/core/src/ClineCore.ts:101)   [estado, sessão, storage, MCP]
    → RuntimeBuilder (runtime/orchestration/runtime-builder.ts:423)
      → AgentRuntime (sdk/packages/agents/src/agent-runtime.ts:533)  [loop stateless]
        → modelo (@cline/llms gateway) → tool calls → hooks → eventos
          → persistência (session/services/persistence-service.ts:43) + checkpoints git
```

- Entry point: `apps/cli/src/main.ts:178-200` (routing de subcomandos) e `ClineCore.ts:101`.
- Loop do agente: `sdk/packages/agents/src/agent-runtime.ts:839-1029` (`while` com `maxIterations`).
- Execução de ferramenta: `agent-runtime.ts:2360` (`executeToolCalls`) e 2457-2515 (hooks + policy).
- Streaming: `agent-runtime.ts:855-856` (`generateAssistantMessageWithProviderRetry`), com eventos
  `turn-started`/`turn-finished`/`message-added` emitidos no caminho (linhas 846-864).
- Persistência: `sdk/packages/core/src/session/services/persistence-service.ts:43` e
  `services/storage/sqlite-session-store.ts`.

A separação `agents` (puro) vs `core` (stateful) é o que permite testar o loop sem disco. Nosso
`src/core/agent/runner.ts` hoje carrega as duas responsabilidades; o desenho do Cline é um argumento
para separar.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `run_commands` | `sdk/packages/core/src/extensions/tools/definitions.ts:530` | executa shell com guarda de comando | alto |
| `read_files` | `definitions.ts:275` | lê arquivos (com limites) | baixo |
| `search_codebase` | `definitions.ts:372` | busca por conteúdo/padrão | baixo |
| `apply_patch` | `definitions.ts:670` | aplica patch (parser próprio em `executors/apply-patch-parser.ts`) | médio |
| `editor` | `definitions.ts:719` | edição cirúrgica de arquivo | médio |
| `fetch_web_content` | `definitions.ts:576` | baixa e converte página | médio |
| `skills` | `definitions.ts:789` | carrega skills do workspace | baixo |
| `ask_question` | `definitions.ts:854` | pergunta ao usuário | baixo |
| `submit_and_exit` | `definitions.ts:886` | encerra a tarefa com resultado | baixo |
| tools de time | `extensions/tools/team/team-tools.ts`, `multi-agent.ts` | spawn/mensagem entre agentes | alto |
| `spawn_agent` | `extensions/tools/team/multi-agent.ts` | subagente configurável | alto |
| MCP | `extensions/mcp/*` | ferramentas de servidores MCP | médio |

A guarda de comandos é notável: `extensions/tools/command-guard.ts:23` tem uma lista de comandos
bloqueados e `BLOCKED_SUBCOMMANDS` por gerenciador de pacote (`npm install`, `pip install`, `cargo
install`, `winget install`, etc., linhas 77-152). Ela também normaliza wrappers e palavras reservadas
(`command-guard.ts:189-222`) antes de decidir.

## 5. Loop do agente, contexto e streaming

**Loop.** `run()` monta mensagens iniciais, injeta lembretes (`completionToolReminder`,
`agent-runtime.ts:828-831`), drena contexto de hooks (`flushPendingHookContexts`, 833-835) e entra no
`while` limitado por `config.maxIterations` (839-842). Cada iteração emite `turn-started`, limpa o
estado de erro (`resetLastError`, 854) e chama o provedor com retry próprio.

**Classificação de falha.** O código trata explicitamente: stream interrompido sem conteúdo continua
(857-865); `finishReason === "aborted"` lança `AgentRuntimeAbortError` (866-868); resposta vazia com
`finishReason === "error"` falha com a mensagem do provedor (876-879); `content-filter` tem mensagem
terminal própria (`CONTENT_FILTER_EMPTY_TURN_MESSAGE`, 98-99); `max-tokens` tenta recuperação com
nudge antes de falhar (928-937). O limite de recuperação é 3 turnos consecutivos cortados, resetando
quando há progresso (`MAX_TOKENS_RECOVERY_LIMIT`, 61-75).

**Retry.** Erros transitórios têm 3 retries com backoff exponencial de 1 s a 15 s
(`PROVIDER_ERROR_MAX_RETRIES`, `PROVIDER_ERROR_RETRY_BASE_DELAY_MS`, `PROVIDER_ERROR_RETRY_MAX_DELAY_MS`,
87-91) e `abortableDelay` para o cancelamento não ficar preso no sleep (1337-1340).

**Compactação.** `createContextCompactionPrepareTurn` (`extensions/context/compaction.ts:267`) escolhe
estratégia `agentic` (default) ou `basic`; o gatilho é 90% do input (`COMPACTION_TRIGGER_RATIO`,
`compaction-shared.ts:19`), preserva 20.000 tokens recentes (`DEFAULT_PRESERVE_RECENT_TOKENS`,
`compaction-shared.ts:29`), corta tool result em 2.000 chars (`TOOL_RESULT_CHAR_LIMIT`, linha 35) e
resume com no máximo 8.192 tokens de saída (`DEFAULT_SUMMARY_MAX_OUTPUT_TOKENS`, linha 34). Em
`overflowRecovery`, força a estratégia `basic` porque "recovery must not depend on another successful
LLM request" (`compaction.ts:47-54,486-490`). Se não há histórico, há mensagem terminal específica
(`agent-runtime.ts:106-107`).

**Anti-loop.** `LoopDetectionTracker` compara assinatura normalizada de input (ordenação de chaves) e
dispara aviso em 3 chamadas idênticas e parada em 5 (`runtime/safety/loop-detection.ts:113-157`).
`MistakeTracker` conta erros consecutivos e produz `ConsecutiveMistakeLimitContext`
(`runtime/safety/mistake-tracker.ts:80-130`).

## 6. Sessões, estado e persistência

`ClineCore` orquestra sessões; `UnifiedSessionPersistenceService`
(`session/services/persistence-service.ts:43`) grava manifest + mensagens, com **OCC de 4 tentativas**
(`OCC_MAX_RETRIES`, linha 41) e reconciliação de sessões órfãs (`STALE_REASON =
"failed_external_process_exit"`, linhas 46-48). Há dois backends: arquivo/manifest
(`session/stores/session-manifest-store.ts`) e SQLite (`services/storage/sqlite-session-store.ts`,
`sqlite-team-store.ts`).

- **Checkpoint/restore**: `session/checkpoint-restore.ts` usa `git stash push --include-untracked` em
  ref privada e `git clean -fd` na restauração (linhas 45-75) — é um checkpoint de worktree, não só
  de mensagens.
- **Versionamento**: `session/session-versioning-service.ts:141` (`SessionVersioningService`) valida
  códigos de erro próprios (`SessionVersioningErrorCode`, linha 24).
- **Fork/child sessions**: `session/team/team-child-session-manager.ts` e
  `session/team/team-session-coordinator.ts` coordenam sessões filhas de um time.
- **Busca**: `session/search/session-history-search.ts` indexa histórico de sessão.
- **Título**: derivado do primeiro prompt (`deriveTitleFromPrompt`, importado em
  `persistence-service.ts:14`).

## 7. Configuração e extensibilidade

- **Config**: `sdk/packages/core/src/settings` + `services/storage/provider-settings-manager.ts`;
  migração de settings legados em `provider-settings-legacy-migration.ts` (36 KB).
- **Camadas**: `shared` (contratos), `llms` (provedores/modelos), `agents` (loop), `core` (estado).
  Um pacote não importa o de cima (`sdk/AGENTS.md`, "Dependency Direction").
- **Hooks**: `sdk/packages/shared/src/*` + `core/src/hooks`; hooks de checkpoint em
  `hooks/checkpoint-hooks.ts`; o CLI expõe `cline hook` para receber payload por stdin.
- **MCP**: `core/src/extensions/mcp/*` e `sdk/packages/shared/src/mcp.ts`; tools MCP entram no
  catálogo via `loadConfiguredMcpTools` (`runtime-builder.ts:210`).
- **Plugins**: `core/src/extensions/plugin/*` e `agent-plugin`; CLI instala por nome/caminho.
- **Skills**: `core/src/extensions/tools` + CLI `skill` (delega ao `npx skills`).
- **Times**: `extensions/tools/team/*` com `team-tools.ts` (28 KB) e `multi-agent.ts` (58 KB).
- **Cron/automação**: `core/src/cron/*` com store, runner e specs; CLI `schedule`.

## 8. Permissões, sandbox e erros

Permissão é **por ferramenta**, resolvida por merge de política global (`*`) e específica
(`resolveToolPolicy`, `agent-runtime.ts:216-224`). O fluxo em `executeToolCalls`:
hooks `beforeTool` podem substituir a chamada ou devolver `{ skip, stop, reason }`
(`agent-runtime.ts:2457-2495`); depois a política decide — se `autoApprove === false`, chama
`requestToolApproval` (`agent-runtime.ts:2499-2533`), que falha fechado quando não há callback
configurado ("requires approval but no approval callback is configured", 2526-2530). A resposta pode
ser `approved`, `reason` ou erro, e o erro vira mensagem para o modelo (2553).

Sandbox existe em dois níveis: guarda de comando (`command-guard.ts`) e isolamento de execução
(`runtime/tools/subprocess-sandbox.ts`, `runtime/tools/worker-sandbox.ts`). O desktop usa o sandbox do
Tauri; a extensão VS Code herda o do editor. Não há seatbelt/landlock — é isolamento lógico.

Erros: `AgentRuntimeAbortError` (classe em 336-349), `ControlledStopError` (326) e mensagens
terminal-specific para overflow (`CONTEXT_WINDOW_OVERFLOW_*`, 106-121). O CLI traduz falhas em
`ctx.exitCode` (`apps/cli/src/main.ts:244`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| unit SDK | `sdk/packages/*/src/**/*.test.ts` | loop, compaction, tools, storage |
| loop do agente | `agents/src/agent-runtime.test.ts` (146 KB) | turnos, retry, abort, políticas |
| compactação | `extensions/context/compaction.test.ts` (140 KB) | estratégias, overflow, orçamento |
| CLI unit | `apps/cli/src/**/*.test.ts` | comandos, parsing, help |
| CLI e2e | `apps/cli/src/cli.e2e.test.ts`, `cli.interactive.e2e.test.ts` | fluxo real de terminal |
| extensão VS Code | `apps/vscode/src/**/__tests__` + `test:integration` | host real do VS Code |
| evals | `evals/` | qualidade de tarefas |

O padrão é teste ao lado do código com Vitest e nomes descritivos longos. O tamanho dos testes de
runtime (146 KB) mostra que o loop é testado por comportamento, não por mock de provider: há testes de
turno com provedor falso, de política de ferramenta e de compactação com orçamento forçado.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Política de ferramenta com merge `*` + específico | `agents/src/agent-runtime.ts:216-224,2494-2515` | precedência simples e previsível; falha fechado sem callback | Apache-2.0 | `src/core/tools/policy.ts` | 23 |
| Estratégia de compactação plugável (agentic/basic) | `core/src/extensions/context/compaction.ts:267-304` | `basic` determinístico para recovery, `agentic` para o normal | Apache-2.0 | `src/core/agent/compaction.ts` | 22 |
| Anti-loop por assinatura de chamada | `core/src/runtime/safety/loop-detection.ts:113-157` | soft 3 / hard 5 com input normalizado | Apache-2.0 | `src/core/agent/loop-guard.ts` | 21 |
| Guarda de comando por subcomando | `core/src/extensions/tools/command-guard.ts:23-152` | bloqueia `npm install` etc. sem bloquear `npm test` | Apache-2.0 | `src/core/tools/command-guard.ts` | 21 |
| Recuperação de max-tokens com nudge | `agents/src/agent-runtime.ts:61-75,928-937` | 3 tentativas com mensagem que pede concisão | Apache-2.0 | `src/core/agent/recovery.ts` | 19 |
| Checkpoint de worktree via git stash | `core/src/session/checkpoint-restore.ts:45-75` | restaura arquivos não commitados com transação | Apache-2.0 | `src/core/session/checkpoint.ts` | 20 |
| Persistência com OCC | `core/src/session/services/persistence-service.ts:41-48` | 4 retries e reconciliação de órfãs | Apache-2.0 | `src/core/session/store.ts` | 17 |
| Mistake tracker | `core/src/runtime/safety/mistake-tracker.ts:80-130` | para após N erros consecutivos com contexto | Apache-2.0 | `src/core/agent/mistake-tracker.ts` | 16 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Monorepo com 4 apps (VS Code/Tauri/CLI/hub) | nosso produto é Electron único; o custo de sincronizar 4 clientes não se paga |
| gRPC/protobuf do webview | já temos IPC tipado; protobuf adicionaria codegen e versão de schema |
| Hub daemon + WebSocket | duplica o servidor que já temos no processo principal |
| Cron/`schedule` | nosso `src/core/scheduler` já cobre; importar outro modelo criaria dois relógios |
| `connect` (Slack etc.) | integração de produto, não de harness |
| Times/multiagente com `team-*` | 100 KB de coordenação para um recurso que ainda não temos |

## 12. Modelo de exemplo para o nosso harness

1. **Separar loop puro de sessão.** Mover a decisão de "chamar modelo / executar ferramenta" para um
   `AgentLoop` sem I/O (equivalente a `@cline/agents`) e deixar `src/core/session/*` injetar storage,
   permissões e ferramentas. Testar o loop com um provider fake passa a ser trivial.
2. **Política de ferramenta em duas camadas.** `toolPolicies["*"]` como default e
   `toolPolicies[name]` como override, com `autoApprove`, `enabled` e `requireApproval`. O default
   deve ser **negar** quando não há callback de aprovação — copiar a decisão de
   `agent-runtime.ts:2526-2530`.
3. **Compactação com dois modos.** `agentic` para o caminho normal (resumo por LLM) e `basic`
   determinístico para recovery de overflow. O erro que isso evita: o resumo falhar por contexto e a
   sessão ficar presa.
4. **Dois freios independentes.** `loop-guard` (chamadas idênticas) e `mistake-tracker` (erros
   consecutivos). São sintomas diferentes: repetição vs falha.
5. **Checkpoint de arquivos, não só de mensagens.** Antes de uma edição destrutiva, `git stash` em ref
   privada com `--include-untracked`; restaurar é `stash apply` + `clean`. Isso dá "desfazer" real
   sem depender de snapshot proprietário.
6. **Como testar.** Tabela de política (ferramenta × modo → allow/ask/deny), teste de loop com
   sequência `tool-call → tool-result → texto`, e teste de compactação forçando `overflowRecovery`
   para garantir que não chama o LLM de novo.

## 13. Evidências da análise

```text
git -C repositorios/_research/agents/cline--cline rev-parse HEAD
  -> 40c5d99031fe1128189c5b52e40638d2b7787754

Leituras:
  sdk/packages/agents/src/agent-runtime.ts:1-180,200-289,820-939,2360-2560
  sdk/packages/core/src/extensions/context/compaction.ts:1-150,200-310
  sdk/packages/core/src/extensions/context/compaction-shared.ts:1-40
  sdk/packages/core/src/runtime/safety/loop-detection.ts:80-162
  sdk/packages/core/src/runtime/safety/mistake-tracker.ts:33-130
  sdk/packages/core/src/extensions/tools/command-guard.ts:23-152
  sdk/packages/core/src/extensions/tools/definitions.ts:99-886
  sdk/packages/core/src/session/services/persistence-service.ts:1-100
  sdk/packages/core/src/session/checkpoint-restore.ts:1-80
  sdk/packages/core/src/ClineCore.ts:98-120
  apps/cli/src/main.ts:178-612
  apps/cli/src/commands/*.ts (nomes)

Contagens:
  git ls-files            -> 4367
  fontes (ts/tsx/js/py...) -> 3880
  linhas somadas          -> 1171718
  arquivos de teste       -> 1017 (apps 637 / sdk 377)
  LICENSE                 -> Apache License 2.0
```

Lacunas: não abri `packages/llms` (gateway de provedores) nem `apps/vscode` em profundidade; a
descrição do gRPC vem dos `.proto` e do `AGENTS.md`, não do servidor. O fluxo exato de
`requestToolApproval` até a UI não foi rastreado além do callback.
