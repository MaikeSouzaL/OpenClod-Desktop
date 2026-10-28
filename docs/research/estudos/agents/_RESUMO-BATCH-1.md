# Resumo do batch 1 — agentes

> Estudo de 5 clones (OpenCode, Codex, Cline, Aider, Goose), leitura estática,
> com caminho e linha no arquivo individual de cada um. Este resumo consolida
> o que vale portar para o Openclod, o que foi descartado e onde há lacuna.

## Arquivos deste batch

| Repositório | Estudo | Commit | Licença |
|---|---|---|---|
| OpenCode | [`opencode.md`](./opencode.md) | `0749dec67568a5a4dcc8ce42b2db5da8fe4ce6fa` | MIT |
| OpenAI Codex CLI | [`openai--codex.md`](./openai--codex.md) | `970111f6cb62cc02fe36a82ea7d71b37a2889c97` | Apache-2.0 |
| Cline | [`cline--cline.md`](./cline--cline.md) | `40c5d99031fe1128189c5b52e40638d2b7787754` | Apache-2.0 |
| Aider | [`Aider-AI--aider.md`](./Aider-AI--aider.md) | `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` | Apache-2.0 |
| Goose | [`block--goose.md`](./block--goose.md) | `2b17adc33a7176e701c2fef9578a5fc5834ea89a` | Apache-2.0 |

## O que cada um é, em uma linha

- **OpenCode**: harness completo com servidor local e sessão em SQLite; o valor
  está na fila durável (`queue`/`steer`) e no runner de um passo por chamada.
- **Codex**: workspace Rust com sandbox de SO de verdade; o valor está na
  política de execução por prefixo e no log append-only de rollout.
- **Cline**: SDK stateless + core stateful; o valor está na política de
  ferramenta em duas camadas e na compactação com modo determinístico.
- **Aider**: sem tool calling, edição por formato textual; o valor está no repo
  map com PageRank e no resumo assíncrono com detecção de corrida.
- **Goose**: execução como state machine de operações; o valor está na
  composição de passos e na permissão por inspectores agregados.

## Top 10 candidatos de port

Score 0–25: valor para o nosso harness × aderência a TypeScript/Electron ×
licença × evidência de teste. Não mede tamanho de código. Os destinos seguem
a árvore real de `src/core` (por isso `security/` e não `permissions/`, que é
o nome usado no resumo do batch 2).

| # | Candidato | Origem | Por que | Destino proposto | Score |
|---|---|---|---|---|---|
| 1 | State machine de operações | `crates/goose-agent/src/machine.rs:45-267` (Goose) | passos plugáveis e ordenados; testável operação por operação, sem modelo | `src/core/agent/state-machine.ts` | 25 |
| 2 | Runner de um passo por chamada, com retomada | `packages/core/src/session/runner/llm.ts:185-332` (OpenCode) | histórico relido do banco a cada passo; retry/overflow/output-limit distintos | `src/core/agent/runner.ts` | 25 |
| 3 | Inbox durável com `queue`/`steer` | `packages/core/src/session/inbox.ts:45-108`; `session/session.ts:140-176` (OpenCode) | separa admissão de execução e permite steer sem perder ordem | `src/core/session/inbox.ts` | 24 |
| 4 | Repo map por PageRank | `aider/repomap.py:365-629` (Aider) | seleciona símbolos por centralidade, com cache e orçamento de tokens | `src/core/code-intelligence/repomap.ts` | 24 |
| 5 | Compactação com checkpoint estruturado | `packages/core/src/session/compaction.ts:159-231` (OpenCode) | template de 7 seções + "histórico novo vence checkpoint" | `src/core/agent/compaction.ts` | 24 |
| 6 | Permissão por inspectores agregados | `crates/goose/src/tool_inspection.rs:12-120`; `permission/permission_inspector.rs:73-110` (Goose) | allow/ask/deny com motivo e confiança, somando regra + anotação MCP | `src/core/security/inspectors.ts` | 23 |
| 7 | Política de execução por prefixo | `codex-rs/execpolicy/src/policy.rs:71-120`; `rule.rs` (Codex) | tokeniza o comando; `git status; rm -rf /` não casa como `git status` | `src/core/security/exec-policy.ts` | 23 |
| 8 | Tool policy com merge global + específico | `sdk/packages/agents/src/agent-runtime.ts:216-224,2499-2533` (Cline) | precedência simples e falha fechado quando não há callback de aprovação | `src/core/tools/policy.ts` | 23 |
| 9 | Tool runtime com Schema→JSON Schema | `packages/core/src/tool/runtime.ts:22-60` (OpenCode) | valida entrada, tipa saída, achata `allOf` e inline `$ref` | `src/core/tools/runtime.ts` | 21 |
| 10 | Rollout JSONL append-only | `codex-rs/rollout/src/recorder.rs:82-102` (Codex) | log imutável; fork/revert por arquivo novo, sem reescrever histórico | `src/core/session/rollout.ts` | 20 |

### Menções honrosas (11–16)

| Candidato | Origem | Destino | Score |
|---|---|---|---|
| Anti-loop por assinatura de chamada (soft 3 / hard 5) | `sdk/packages/core/src/runtime/safety/loop-detection.ts:113-157` (Cline) | `src/core/agent/loop-guard.ts` | 20 |
| Tool pair compaction em lotes de 10 | `crates/goose/src/context_mgmt/mod.rs:383-461` (Goose) | `src/core/agent/compaction.ts` | 20 |
| Checkpoint de worktree via `git stash` | `sdk/packages/core/src/session/checkpoint-restore.ts:45-75` (Cline) | `src/core/session/checkpoint.ts` | 20 |
| Snapshot antes/depois do passo | `packages/core/src/session/runner/step.ts:236-259` (OpenCode) | `src/core/session/snapshot.ts` | 19 |
| Resumo assíncrono com checagem de corrida | `aider/coders/base_coder.py:1002-1034` (Aider) | `src/core/agent/compaction.ts` | 19 |
| Dois eixos: aprovação + sandbox | `codex-rs/protocol/src/protocol.rs:1098-1205` (Codex) | `src/core/security/policy.ts` | 19 |

## Como os cinco se combinam

Não copiar nenhum loop inteiro. O desenho recomendado é híbrido e complementa o
batch 2 (que já cobriu `apply_patch`, truncamento e tupla de permissão):

1. **Loop** como state machine (Goose) cujos passos chamam o runner de passo
   único (OpenCode). A máquina dá ordem e extensibilidade; o runner dá
   semântica de retry/overflow.
2. **Entrada** por inbox durável com `queue`/`steer` (OpenCode), sem promover
   prompt enfileirado em limite de steer.
3. **Contexto** em três camadas: repo map por PageRank (Aider) como pré-prompt,
   checkpoint estruturado (OpenCode) como resumo, e tool pair compaction
   (Goose) para outputs antigos.
4. **Segurança** em três filtros: política de ferramenta (Cline), política de
   execução por prefixo (Codex) e inspectores agregados (Goose). Nenhum deles
   bloqueia sozinho; a decisão final é do agregado.
5. **Sessão** com rollout JSONL append-only (Codex) por baixo e snapshot de
   arquivos (OpenCode/Cline) por cima, dando undo real e fork barato.
6. **Ferramentas** com validação de schema na fronteira (OpenCode) e catálogo
   composto que nunca deixa `tool_call` órfão (Goose).

## Sequência de implementação sugerida

| Fase | Entrega | Depende de |
|---|---|---|
| 1 | Runner de passo único + síntese de tool response órfã | nada |
| 2 | State machine de operações com 3 operações (prompt, tool, stop) | fase 1 |
| 3 | Inbox `queue`/`steer` + testes de limite | fase 1 |
| 4 | Política de ferramenta + exec policy por prefixo | fase 2 |
| 5 | Inspectores agregados + UI de `awaiting_approval` | fase 4 |
| 6 | Repo map + compactação (checkpoint e tool pair) | fase 1 |
| 7 | Rollout JSONL + snapshot/undo | fase 1 |

## Lacunas e o que não foi verificado

- **Não executei** build, testes ou CLIs dos clones (regra da tarefa). Todos os
  números vêm de contagem de arquivos (`git ls-files` + soma de linhas), não de
  execução de suíte.
- **OpenCode**: não abri `packages/server` (HttpApi) nem `packages/tui`; a
  camada HTTP foi inferida do contrato de CLI (`serve`, `--server`, `service`).
  `codemode/*` não foi estudado.
- **Codex**: não li `app-server-protocol` inteiro; só confirmei o transporte
  JSON-RPC (`app_server_tracing.rs:104`) e a conversão de `ClientRequest`
  (`protocol/common.rs:271`), não todos os métodos. Também não abri
  `code-mode-runtime`, `exec-server` e `realtime-*`.
- **Cline**: `packages/llms` (gateway) e `apps/vscode` não foram analisados; o
  gRPC é descrito pelos `.proto` e pelo `sdk/AGENTS.md`, não pelo servidor.
- **Aider**: não li `aider/watch.py`, `aider/gui.py` nem `aider/history.py`. A
  ausência de MCP/hooks vem de busca por nome, não de leitura exaustiva.
- **Goose**: `extension_malware_check.rs` (35 KB), `mcp_client.rs` (50 KB) e
  `security/scanner.rs` não foram lidos. "Sem sandbox de SO" é resultado de
  busca por `seatbelt|landlock|bwrap|fn sandbox`, sem ocorrências.
- **Licenças**: MIT e Apache-2.0 são compatíveis com uso interno. Codex, Cline,
  Aider e Goose exigem manter o `LICENSE`/`NOTICE` em código derivado; o
  OpenCode exige o aviso MIT.
- **Sobreposição com o batch 2**: truncamento de output, `apply_patch` e tupla
  de permissão já aparecem lá. Este batch não os repete no top 10; reforça o
  mesmo tema por outro ângulo (inspectores, exec policy, schema na fronteira).
