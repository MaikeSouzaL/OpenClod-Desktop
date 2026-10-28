# Resumo do batch 2 — agentes

> Estudo de 5 clones em `repositorios/_research/agents/`, leitura estática,
> com caminho e linha em cada arquivo individual. Este resumo consolida o que
> vale portar para o Openclod e o que foi descartado.

## Arquivos deste batch

| Repositório | Estudo | Commit | Licença |
|---|---|---|---|
| OpenHands / Agent Canvas | [`All-Hands-AI--OpenHands.md`](./All-Hands-AI--OpenHands.md) | `b185939d3dec3b203b0651c675f175ee5b4ed43e` | MIT |
| SWE-agent | [`SWE-agent--SWE-agent.md`](./SWE-agent--SWE-agent.md) | `3ea751c087f32b16e039a2233dd6eefecef325d5` | MIT |
| Open Interpreter (Codex fork) | [`OpenInterpreter--open-interpreter.md`](./OpenInterpreter--open-interpreter.md) | `ac1fcc8fe57aba51fcc3c79afd57a0883237fe87` | Apache-2.0 |
| Qwen Code | [`QwenLM--qwen-code.md`](./QwenLM--qwen-code.md) | `b3783a36aae503a13b3d7dad3614f3ff78249413` | Apache-2.0 |
| Kilo Code | [`Kilo-Org--kilocode.md`](./Kilo-Org--kilocode.md) | `9723be621429771ea47a2614b0ac433448023cec` | MIT |

## O que cada um é, em uma linha

- **OpenHands**: UI/desktop para um agent-server Python externo; o valor está
  no cliente (streaming, permissão, fork, delegação), não no loop.
- **SWE-agent**: loop de pesquisa com uma ação por passo, catálogo de
  ferramentas em YAML/bash e entrega em dois estágios com review.
- **Open Interpreter**: fork Rust do Codex CLI; referência de sandbox,
  política de execução e `apply_patch` com gramática.
- **Qwen Code**: monorepo TS (fork do Gemini CLI) com o motor de permissões
  mais completo e um loop com motivos de parada explícitos.
- **Kilo Code**: fork do opencode (Bun/Effect) com permissão por tupla,
  snapshots git e delegação com background.

## Top 10 candidatos de port

Score 0–25: valor para o nosso harness × aderência a TypeScript/Electron ×
licença × evidência de teste. Não é "tamanho do código".

| # | Candidato | Origem | Por que | Destino proposto | Score |
|---|---|---|---|---|---|
| 1 | Ferramenta `apply_patch` freeform com gramática Lark | `codex-rs/core/assets/tools/apply_patch.lark:1-19`; `.../handlers/apply_patch_spec.rs:9-28` (Open Interpreter) | edição multi-arquivo/hunk determinística, sem `diff` frágil; o formato já é familiar a modelos | `src/core/tools/apply-patch/` | 24 |
| 2 | Permissão como tupla `{action, resource, effect}` + resposta `once/always/reject` + correção com feedback | `packages/schema/src/permission.ts:40-64`; `packages/core/src/v1/permission.ts:13-27` (Kilo) | modelo mínimo, com regra vencedora exposta à UI e correção no mesmo turno | `src/core/permissions/model.ts` | 24 |
| 3 | Entrega em dois estágios com review obrigatório | `tools/review_on_submit_m/bin/submit:23-46`; `config/default.yaml:47-63` (SWE-agent) | transforma "terminei" em "revisei"; reduz patch com teste alterado | `src/core/tools/submit-review.ts` | 24 |
| 4 | Motor de regras `Tool(specifier)` com escopos + L3/L4 | `packages/core/src/permissions/types.ts:7-45`; `core/permissionFlow.ts:8-15` (Qwen Code) | 4 escopos e 4 tipos de match; base para policy versionada | `src/core/permissions/rules.ts` | 23 |
| 5 | Cursor `seq` + resume `after_seq` | `src/utils/session-seq-cursor.ts`; `src/contexts/conversation-websocket-context.tsx:1142-1151` (OpenHands) | reconexão sem duplicar nem perder evento | `src/core/session/seq-cursor.ts` | 23 |
| 6 | Leitura prévia obrigatória + detecção de drift | `packages/core/src/tools/priorReadEnforcement.ts:14-55` (Qwen Code) | impede edição às cegas e sobrescrita de arquivo mudado | `src/core/tools/prior-read.ts` | 23 |
| 7 | Aridade de comando shell para permissão | `packages/opencode/src/permission/arity.ts:1-40` (Kilo) | normaliza `git commit -m x` → `git commit`; flags não contam | `src/core/permissions/arity.ts` | 23 |
| 8 | Truncar output salvando o arquivo completo | `packages/opencode/src/tool/truncate.ts:12-40` (Kilo) | 2 000 linhas/50 KB na conversa, tudo em disco por 7 dias | `src/core/tools/truncate.ts` | 22 |
| 9 | Batcher de deltas por frame + flush antes de evento durável | `src/utils/streaming-delta-batcher.ts:29-57` (OpenHands) | evita re-render por token sem quebrar ordem | `src/core/streaming/delta-batcher.ts` | 22 |
| 10 | Modos de aprovação + estado `awaiting_approval` | `packages/core/src/config/approval-mode.ts:7-13`; `coreToolScheduler.ts:714-722` (Qwen Code) | vocabulário claro (`plan/default/auto-edit/auto/yolo`) e estado de UI de primeira classe | `src/core/permissions/modes.ts` | 22 |

### Menções honrosas (fora do top 10)

| Candidato | Origem | Destino | Score |
|---|---|---|---|
| Delegação com brief autocontido + `background`/`task_id` | `src/tool/task.ts:36-60`, `task.txt:1-19` (Kilo) | `src/core/tools/task.md` | 21 |
| `TurnDiffTracker` sem reler disco | `core/src/turn_diff_tracker.rs:47-60` (Open Interpreter) | `src/core/patch/turn-diff.ts` | 21 |
| Fork por evento + `parentEventId` | `src/hooks/mutation/use-fork-conversation.ts:38-68` (OpenHands) | `src/core/session/fork.ts` | 21 |
| Microcompactação (limpar resultados antigos) | `packages/core/src/services/microcompaction/microcompact.ts:14-50` (Qwen) | `src/core/context/microcompact.ts` | 21 |
| Snapshot git + revert por mensagem | `src/snapshot/index.ts:28-57`, `session/revert.ts:16-27` (Kilo) | `src/core/session/snapshot.ts` | 20 |
| Blocklist de comandos interativos | `sweagent/tools/tools.py:37-72` (SWE-agent) | `src/core/permissions/command-filter.ts` | 20 |
| Preservação de CRLF/BOM no edit | `src/tool/edit.ts:27-60` (Kilo) | `src/core/tools/text-edit.ts` | 20 |

## Como os cinco se combinam

Não copiar nenhum loop inteiro. O desenho recomendado é híbrido:

1. **Loop** com motivos de parada explícitos (Qwen,
   `core/agent-loop.ts:40-59`) e limite de passos que pede resumo em vez de
   matar (Kilo, `max-steps.ts:1-16`).
2. **Permissão** com tupla + regras `Tool(spec)` + aridade de shell (Kilo +
   Qwen), e aprovação `once/always/reject` com correção.
3. **Edição** por `apply_patch` gramatical (Open Interpreter) e `edit` que
   preserva CRLF/BOM (Kilo), exigindo leitura prévia (Qwen).
4. **Contexto** em três passes: truncar com arquivo completo (Kilo), limpar
   resultados antigos (Qwen), resumir com orçamento medido (OpenHands mede o
   ganho; Qwen define os números).
5. **Sessão** em JSONL/eventos com `seq`, resume e fork por evento
   (OpenHands + Open Interpreter + Kilo snapshot).
6. **Entrega** com gate de dois estágios e diff anexado (SWE-agent).

## Sequência de implementação sugerida

| Fase | Entrega | Depende de |
|---|---|---|
| 1 | `apply_patch` + `text-edit` (CRLF/BOM) + leitura prévia | nada |
| 2 | Modelo de permissão + aridade + modos + `awaiting_approval` | fase 1 |
| 3 | Truncamento com arquivo + microcompactação | fase 1 |
| 4 | Eventos com `seq`, resume e fork | fase 2 |
| 5 | Gate de entrega em dois estágios | fases 1–3 |
| 6 | Delegação (task/sub-sessão) com snapshot/revert | fases 2–4 |

## Lacunas e o que não foi verificado

- **Não executei** build, testes ou CLIs dos clones (regra da tarefa). Todos os
  números de teste vêm de contagem de arquivos, não de execução.
- **OpenHands**: o loop do agente não está no clone (roda em agent-server
  Python via `uvx`); não li o código Python do servidor. Tudo sobre o loop é
  inferido do protocolo e do cliente.
- **Open Interpreter**: o workspace tem ~1,79 M linhas de Rust; li apenas
  `core/session`, `tools`, `safety`, `execpolicy`, `apply-patch`, `rollout` e
  `sandboxing`. Crates de cloud/realtime/code-mode não foram analisados.
- **Qwen Code**: 1,1 M linhas só no core; não mapeei todos os ~80 slash
  commands nem os canais. A linha do tempo do loop em `client.ts` foi lida por
  símbolos, não integralmente.
- **Kilo Code**: o fork tem 3.517 patches inline; não separei o que é upstream
  opencode do que é Kilo. `packages/kilo-indexing`, `kilo-memory` e
  `kilo-gateway` não foram estudados.
- **SWE-agent**: `run-api` aponta para `sweagent.api.server`, ausente neste
  commit; não investiguei se é release quebrada ou branch incompleta.
- **Licenças**: MIT e Apache-2.0 são compatíveis com uso interno, mas
  `OpenInterpreter` exige manter `NOTICE` (atribuição a OpenAI Codex) em
  qualquer código derivado.
- **Não medido**: custo real de port (estimativas por tamanho e acoplamento),
  desempenho do batcher, e se o `apply_patch` cobre os casos do nosso editor.
