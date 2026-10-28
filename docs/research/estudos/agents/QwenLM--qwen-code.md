# Qwen Code

| Campo | Valor |
|---|---|
| Repositório | https://github.com/QwenLM/qwen-code |
| Clone local | `repositorios/_research/agents/QwenLM--qwen-code` |
| Commit | `b3783a36aae503a13b3d7dad3614f3ff78249413` |
| Licença | Apache-2.0 (`LICENSE:2`); arquivos derivados mantêm "Copyright 2025 Google LLC" (`packages/core/src/tools/tool-names.ts:3`) |
| Categoria | agents (CLI/daemon/editor/desktop) |
| Stack | TypeScript strict + Node >= 22 + pnpm 11 workspaces + `@google/genai` + Ink/React para TUI + Vitest + esbuild; Rust pontual em `packages/cua-driver` |
| Tamanho | 12.939 arquivos; `packages/core/src` sozinho tem 1.989 `.ts/.tsx` e ~1,1 milhão de linhas; 973 testes em `core`, 1.356 em `cli`, 195 arquivos em `integration-tests` |

## 1. O que é (verificado no código)

É um fork do Gemini CLI (Apache-2.0, cabeçalhos Google preservados) transformado
num produto multi-superfície: terminal, daemon (`qwen serve`), VS Code/Zed,
desktop, mobile e canais de chat (`package.json:10-31` lista Telegram, WeChat,
DingTalk, Feishu, QQ, GitHub, GitLab, e-mail). O pacote publicável é
`@qwen-code/qwen-code` com bin `qwen` (`packages/cli/package.json:13-14`).

O núcleo é o monorepo `packages/core`, com loop de agente próprio
(`packages/core/src/core/agent-loop.ts:194`), scheduler de ferramentas com
aprovação (`coreToolScheduler.ts:714-733`), motor de permissões por regras
(`permissions/permission-manager.ts`), compactação em duas camadas e
subagentes/workflows. O CLI monta o yargs e roteia para `serve`, `mcp`,
`memory` etc. (`packages/cli/src/cli.ts:40-45`), com `main()` em
`packages/cli/src/llm.tsx:431`.

Diferente do README (que vende "terminal, editor, desktop, browser e chat"), o
que existe de fato é um núcleo TypeScript compartilhado e vários *hosts* em
pacotes separados (`acp-bridge`, `desktop`, `web-shell`, `vscode-ide-companion`,
`zed-extension`, `channels/*`); o desktop está fora do workspace npm
(`package.json:29-31`).

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `qwen` | `packages/cli/package.json:13-14` | bin principal (dist/index.js) |
| `npm start` | `package.json:41` | build já feito, sobe o CLI |
| `npm run dev` | `package.json:42` | desenvolvimento |
| `npm run build` | `package.json:50` | bundle (esbuild + assets) |
| `npm test` | `package.json:57` | Vitest em todos os workspaces |
| `npm run test:ci` | `package.json:59` | CI (workspaces + scripts) |
| `npm run dev:daemon` | `package.json:43` | daemon de sessões |
| `npm run dev:managed-agent` | `package.json:45` | agente gerenciado |
| `npm run build:sandbox` | `package.json:55` | imagem/container de sandbox |

Superfície de slash commands (famílias, `packages/cli/src/ui/commands/`):
sessão (`clear`, `compress`, `fork`, `branch`, `resume`, `delete`, `export`),
modelo (`model`, `effort`, `approval-mode`, `output-style`), contexto
(`memory`, `context`, `compress`, `forget`), agentes (`agents`, `arena`,
`peers`), ferramentas (`mcp`, `lsp`, `hooks`, `extensions`, `skills`),
produto (`init`, `commit`, `diff`, `doctor`, `auth`, `ide`, `bug`). São ~80
arquivos de comando; não há um único registro central citável.

Hosts alternativos: `qwen serve` (daemon HTTP/ACP), `mcp-server`, SDKs
(`sdk-typescript`, `sdk-python`, `sdk-java`), extensão VS Code e `zed-extension`.

## 3. Arquitetura e fluxo

```
packages/cli/index.ts → src/cli.ts (yargs) → src/llm.tsx:431 main()
  → core Config → GeminiClient.sendMessageStream
  → runAgentLoop (agent-loop.ts:194)
  → LlmChat/stream → CoreToolScheduler (approval) → tools
  → chatRecordingService (JSONL) / fileHistoryService (snapshots)
```

- Entry point: `packages/cli/src/cli.ts:40-45`; UI em `llm.tsx:431`.
- Loop do agente: `packages/core/src/core/agent-loop.ts:194-206`.
- Execução de ferramenta: `packages/core/src/core/coreToolScheduler.ts`
  (`WaitingToolCall` em `:714-722`; `ConfirmHandler` em `:965-967`).
- Streaming: `packages/core/src/core/llm-chat.ts` (o antigo `geminiChat.ts`
  virou shim de 7 linhas) + `client.ts` (`sendMessageStream`).
- Persistência: `packages/core/src/services/chatRecordingService.ts` (JSONL) e
  `fileHistoryService.ts` (snapshots de arquivos).

## 4. Catálogo de ferramentas / capacidades

Nomes canônicos em `packages/core/src/tools/tool-names.ts:22-66`; registro
central em `tools/tool-registry.ts:234` (`ToolRegistry`) e `:428`
(`registerTool`), com factory preguiçosa em `:503`.

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `read_file` | `tools/tool-names.ts:24`; `tools/read-file.ts` | leitura com cache e fingerprint | baixo |
| `write_file` | `:23`; `tools/write-file.ts` | escrita completa | médio |
| `edit` | `:22`; `tools/edit.ts` | substituição com checagem de leitura prévia | médio |
| `run_shell_command` | `:28`; `tools/shell.ts:1-45` | shell com sandbox e confirmação | alto |
| `exec` (code mode) | `:25`; `tools/exec.ts:9-25` | executa JS no host de code-mode | alto |
| `grep_search` / `glob` | `:26-27`; `tools/ripGrep.ts`, `glob.ts` | busca de conteúdo/arquivos | baixo |
| `web_fetch` / `web_search` | `:37-38` | rede, com regra por domínio | médio |
| `todo_write` | `:29` | lista de tarefas do turno | baixo |
| `task_create/update/list/stop` | `:49-52` | tarefas persistentes | baixo |
| `create_sub_session` | `:47`; `tools/create-sub-session.ts:7-28` | abre sub-sessão própria e roda prompt | alto |
| `list_agents` / `send_message` | `tools/list-agents.ts`, `send-message.ts` | descobre e fala com subagentes | médio |
| `enter_plan_mode` / `exit_plan_mode` | `:35-36` | troca de modo com fronteira de batch | baixo |
| `enter_worktree` / `exit_worktree` | `:65-66`; `tools/enter-worktree.ts:29-45` | cria worktree git isolada | médio |
| `save_memory` / `manage_memory` / `search_memory` | `:30-32` | memória de projeto | baixo |
| `skill` | `:34` | ativa skill | médio |
| `mcp__*` / `read_mcp_resource` | `:63` | ferramentas de servidores MCP | alto |
| `cron_create/list/delete` | `:43-45` | agendamento | médio |
| `lsp` | `:41` | símbolos/diagnósticos | baixo |
| `notebook_edit` | `:60` | edita `.ipynb` | médio |

## 5. Loop do agente, contexto e streaming

`runAgentLoop` recebe `client`, `config`, `signal`, `maxRounds` e um executor
de batch (default: `CoreToolScheduler`) (`agent-loop.ts:194-206`) e itera
`for (let index = 0; ; index++)` (`:206`). O resultado é tipado por **motivo de
parada** (`:40-59`): `completed`, `next_round`, `cancelled`, `loop_detected`,
`duplicate_provider_call`, `tool_ended_turn`, `max_session_turns`,
`session_token_limit`, `user_prompt_blocked`. Isso é raro e valioso: a UI sabe
*por que* parou, não só que parou.

Limites: `MAX_TURNS = 100` no cliente (`client.ts:234`), `maxRounds` por
chamada (`agent-loop.ts:180`, checado em `:231`) e orçamento de tokens por
turno lido do próprio prompt (`core/turn-budget.ts:7-45`, `+500k` = alvo de
saída do turno inteiro).

Detecção de loop é um serviço dedicado: hash de chamada repetida, repetição de
conteúdo, repetição de pensamento, leitura de arquivo em excesso e estagnação
de shell, com limiares explícitos (`services/loopDetectionService.ts:82-83`,
`:150-173`) e lembretes antes do corte (`services/loop-protection.ts`).

Streaming: `LlmChat` consome o stream e emite `ServerLlmStreamEvent`
(`core/turn.ts`), incluindo `LoopDetected` mapeado para o motivo de parada
(`agent-loop.ts:244`). Cancelamento é `AbortSignal` (um para o turno, outro
para as tools, `:174-176`).

Contexto tem três camadas: (a) limpeza de resultados antigos
(`microcompaction/microcompact.ts:14-50`), (b) *slimming* do input para o
resumo — remove mídia inline e sanitiza MIME contra injeção
(`services/compactionInputSlimming.ts:12-39`), (c) compressão real com
`chatCompressionService` e resumo lateral, mais retenção por orçamento de cada
ferramenta (`tools/tool-result-retention.ts:20-26`).

## 6. Sessões, estado e persistência

Transcript em JSONL com registros tipados (`ChatRecord`,
`chatRecordingService.ts:287+`), cursor de leitura
(`TranscriptCursor`, `:101`), reescrita de cauda para metadados e grupos de
mensagem (`:84-88`, `:125`). `branch-points.ts` calcula pontos de bifurcação a
partir de `uuid`/`parentUuid` e grava um checkpoint versionado
(`branch-points.ts:11-30`), o que sustenta `/branch` e `/fork`.

Arquivos: `fileHistoryService.ts` tira snapshots antes de editar, com
`MAX_SNAPSHOTS` (`file-history-limits.ts`) e diff por `diffLines`
(`fileHistoryService.ts:19-28`), permitindo rewind por turno. Workflows gravam
`checkpoint.json` ao registrar e o removem ao terminar; um checkpoint órfão
marca run interrompida e é reconciliado no próximo processo
(`agents/workflow-checkpoint.ts:7-22`).

Sessões também são indexadas (`services/session-registry.ts`), resumidas
(`session-api-history.ts`) e exportadas (`/export`).

## 7. Configuração e extensibilidade

- Config por camadas (system/user/workspace/session) e schema gerado
  (`scripts/generate-settings-schema.ts`).
- Regras de permissão declarativas com escopo (`permissions/types.ts:19-20`).
- Skills (`src/skills`), hooks (`src/hooks`, com `stopHookCap`), extensões
  (`src/extension`), plugins, MCP (`src/mcp`, `tools/mcp-*`), LSP (`src/lsp`).
- Memória: `src/memory` (`recall.ts`, `request-context.ts`) e ferramentas
  dedicadas.
- Subagentes e workflows: `src/agents` (`forkedAgent.ts`, `workflow-*`),
  `src/subagents`, `src/goals`.
- Canais de chat como pacotes plugáveis (`packages/channels/*`, com
  `plugin-example`).
- SDKs para TypeScript, Python e Java (`packages/sdk-*`), ACP
  (`packages/acp-bridge`).

## 8. Permissões, sandbox e erros

Modelo em 4 níveis, explícito no código: L3 = permissão intrínseca da
ferramenta; L4 = override do `PermissionManager`
(`core/permissionFlow.ts:8-15`). A decisão final é
`allow | ask | deny | default` (`permissions/types.ts:7-14`), com regras no
formato `Tool(specifier)` e quatro tipos de especificador — comando (glob),
caminho (gitignore-style), domínio e literal (`permissions/types.ts:22-45`).

Modos de aprovação: `PLAN`, `DEFAULT`, `AUTO_EDIT`, `AUTO`, `YOLO`
(`config/approval-mode.ts:7-13`). O scheduler expõe `awaiting_approval` como
estado de primeira classe (`coreToolScheduler.ts:714-722`) e o handler de
confirmação devolve `ToolConfirmationOutcome` (`:965-967`), permitindo
"permitir sempre" sem inventar um caminho paralelo.

Proteções adicionais: `dangerousRules.ts`, `destructive-commands.ts` (com
geração de commit por sessão), `denialTracking.ts` (limite de negações) e
`classifier.ts` (classificador de risco). Leitura prévia obrigatória antes de
editar: `tools/priorReadEnforcement.ts:14-37` devolve decisão estruturada com
`ToolErrorType` e mensagem para o modelo, e recheca fingerprint para detectar
arquivo mudado desde a leitura (`:47-55`).

Sandbox: `src/sandbox/` (`runtime-shell.ts`, `runtime-shell-policy.ts`), usado
pelo shell (`tools/shell.ts:13-15`); container/execução remota em
`services/container-execution-environment.ts`. Erros de ferramenta são
tipados (`tools/tool-error.ts`) e há diagnóstico por `doctor`.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Core (973 arquivos) | `packages/core/src/**/*.test.ts` | loop, scheduler, permissões, contexto |
| CLI (1.356 arquivos) | `packages/cli/src/**/*.test.ts(x)` | comandos, UI Ink, render |
| Integração (195) | `integration-tests/` | fluxos ponta a ponta |
| Vitest projects | `vitest.config.ts:5-20` | 14 projetos, incluindo canais e SDK |
| SDK TS | `packages/sdk-typescript` | contrato público |
| Scripts | `scripts/` (`test:scripts`) | build/release |

Há testes de contrato comportamental que valem como modelo: política de entrada
do plan mode (`core/plan-mode-entry-policy.ts`), replay de tool call duplicada
(`core/toolCallIdUtils.ts`) e restauração de pergunta pendente
(`core/ask-user-question-restore.ts`).

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Permissões L3/L4 + regras `Tool(spec)` | `core/permissionFlow.ts:8-15`; `permissions/types.ts:7-45` | 4 escopos, 4 tipos de match, deny com mensagem | Apache-2.0 | `src/core/permissions/rules.ts` | 24 |
| Leitura prévia obrigatória | `tools/priorReadEnforcement.ts:14-55` | impede edição às cegas e detecta drift | Apache-2.0 | `src/core/tools/prior-read.ts` | 23 |
| Motivos de parada do loop | `core/agent-loop.ts:40-59` | UI/telemetria sabem por que parou | Apache-2.0 | `src/core/agent/stop-reason.ts` | 23 |
| Modos de aprovação | `config/approval-mode.ts:7-13` | plan/default/auto-edit/auto/yolo é um vocabulário claro | Apache-2.0 | `src/core/permissions/modes.ts` | 22 |
| Microcompactação de resultados | `services/microcompaction/microcompact.ts:14-50` | libera contexto sem resumir nem perder o turno | Apache-2.0 | `src/core/context/microcompact.ts` | 22 |
| Detecção de loop | `services/loopDetectionService.ts:82-173` | cinco heurísticas com limiares e lembrete | Apache-2.0 | `src/core/agent/loop-guard.ts` | 21 |
| Sub-sessão com `first-turn`/`sent` | `tools/create-sub-session.ts:7-28` | delegação com contrato de conclusão explícito | Apache-2.0 | `src/core/tools/sub-session.ts` | 21 |
| Orçamento por ferramenta | `tools/tool-result-retention.ts:20-26` | cada tool declara seu teto; global como fallback | Apache-2.0 | `src/core/context/budgets.ts` | 20 |
| Worktree como tool | `tools/enter-worktree.ts:29-45` | isolamento explícito, com regra de quando usar | Apache-2.0 | `src/core/tools/worktree.ts` | 19 |
| Branch points + snapshots | `services/branch-points.ts:11-30`; `fileHistoryService.ts:19-28` | fork e rewind por mensagem | Apache-2.0 | `src/core/session/branch.ts` | 18 |
| Fronteira do plan mode | `core/plan-mode-entry-policy.ts:10-38` | troca de modo não se mistura no mesmo batch | Apache-2.0 | `src/core/agent/plan-mode.ts` | 17 |
| Diretiva de orçamento no prompt | `core/turn-budget.ts:7-45` | usuário dimensiona o turno (`+500k`) | Apache-2.0 | `src/core/budget/directive.ts` | 14 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| O monorepo inteiro (12,9 mil arquivos, 1,1 M linhas só no core) | escala e acoplamento incompatíveis com nosso app |
| TUI Ink/React e ~80 slash commands | já temos UI React própria |
| `@google/genai` como SDK de provider | nosso core é provider-agnóstico |
| Canais Telegram/WeChat/Feishu/DingTalk | produto, não harness |
| `code-mode`/V8 e `exec` JS | superfície de execução extra sem necessidade |
| Arena de agentes e workflows | experimental e caro; só o conceito de checkpoint interessa |
| Desktop/mobile shells | são hosts separados, fora do workspace |
| `classifier.ts` (LLM juiz de risco) | custo e latência; preferir regras determinísticas |

## 12. Modelo de exemplo para o nosso harness

Copiar o **modelo de permissão + o ciclo de contexto**, que é onde este repo é
melhor que os outros quatro:

1. `PermissionDecision = allow | ask | deny | default`, com regra
   `Tool(specifier)` e escopos `system|user|workspace|session`. Match por
   comando (glob), caminho (gitignore), domínio e literal.
2. Duas camadas: default da ferramenta (L3) e override de regras (L4); a UI
   recebe também `pmForcedAsk` para esconder "sempre permitir" quando a regra
   exige ask.
3. `approvalMode` como enum de 5 valores e o estado `awaiting_approval` no
   scheduler, com outcome tipado.
4. Antes de `edit`/`write`, exigir `read_file` na sessão e revalidar
   fingerprint; se mudou, devolver `FILE_CHANGED_SINCE_READ` com instrução de
   reler.
5. Contexto em três passes: limpar resultados antigos (placeholder), podar
   mídia do input de resumo, e só então resumir. Cada tool declara
   `maxOutputChars`; o global é fallback.
6. Loop com `stopReason` explícito e detector de repetição (hash de
   nome+args), devolvendo lembrete antes de cortar.

Teste: uma matriz de regras (allow/ask/deny × 4 tipos de specifier), um teste
de drift de arquivo entre read e edit, e um teste que force `loop_detected` na
5ª chamada idêntica.

## 13. Evidências da análise

```text
git rev-parse HEAD → b3783a36aae503a13b3d7dad3614f3ff78249413
package.json:4,6-8,10-31 → versão 0.26.1, Node >=22, workspaces
packages/core/src → 1.989 arquivos .ts/.tsx, ~1.100.021 linhas
core tests=973; cli tests=1.356; integration=195
packages/cli/index.ts:13-26 → bootstrap (managed-runtime, workspace-recovery)
packages/cli/src/cli.ts:40-45 → rotas serve|mcp|memory|...
packages/cli/src/llm.tsx:431 → main()
core/src/core/agent-loop.ts:40-59 → AgentLoopStopReason
core/src/core/agent-loop.ts:194-206 → runAgentLoop
core/src/core/client.ts:234 → MAX_TURNS = 100
core/src/core/coreToolScheduler.ts:714-722 → awaiting_approval
core/src/core/coreToolScheduler.ts:965-967 → ConfirmHandler
core/src/config/approval-mode.ts:7-13 → 5 modos
core/src/permissions/types.ts:7-45 → decisões, escopos e specifiers
core/src/core/permissionFlow.ts:8-15 → L3→L4
core/src/tools/priorReadEnforcement.ts:14-55 → decisão de leitura prévia
core/src/services/microcompaction/microcompact.ts:14-50 → limpeza
core/src/services/loopDetectionService.ts:82-173 → limiares
core/src/tools/create-sub-session.ts:7-28 → sub-sessão
core/src/tools/enter-worktree.ts:29-45 → worktree
core/src/services/branch-points.ts:11-30 → branch points
core/src/agents/workflow-checkpoint.ts:7-22 → checkpoint órfão
```
