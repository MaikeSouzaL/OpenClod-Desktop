# Matriz consolidada de reúso — 2026-10-26

Estudo estático dos **56 repositórios** clonados em `repositorios/` (55 do prompt
mestre + `munim-computer-use`). Cada repositório tem um estudo individual em
[`estudos/`](./estudos/), com caminho e linha. Esta matriz só consolida decisões.

- Método: leitura de código, sem instalar nem rodar build/testes dos clones.
- Score 0–25: encaixe no harness + qualidade/testes + robustez + licença.
- Regra: **≥18** = portar agora; **10–17** = depois de um pré-requisito;
  **<10** = referência ou descartar.
- Licenças: MIT/Apache/BSD/ISC permitem adaptação com atribuição. GPL/EPL e
  projetos sem licença **não entram** como código.

## 1. Cobertura

| Categoria | Repos | Estudos | Melhor score | Documento |
|---|---:|---:|---:|---|
| agents | 10 | 10 | 25 | [`estudos/agents/`](./estudos/agents/) |
| orchestration | 5 | 5 | 25 | [`estudos/orchestration/`](./estudos/orchestration/) |
| mcp | 5 | 5 | 25 | [`estudos/mcp/`](./estudos/mcp/) |
| computer-use | 4 | 4 | 25 | [`estudos/computer-use/`](./estudos/computer-use/) |
| browser | 4 | 4 | 25 | [`estudos/browser/`](./estudos/browser/) |
| models | 5 | 5 | 25 | [`estudos/models/`](./estudos/models/) |
| code-analysis | 7 | 7 | 20 | [`estudos/code-analysis/`](./estudos/code-analysis/) |
| memory | 5 | 5 | 18 | [`estudos/memory/`](./estudos/memory/) |
| desktop-ui | 7 | 7 | 24 | [`estudos/desktop-ui/`](./estudos/desktop-ui/) |
| testing | 4 | 4 | 24 | [`estudos/testing/`](./estudos/testing/) |
| **total** | **56** | **56 + 11 arquivos de resumo** | - | - |

## 2. Top candidatos por categoria

### Agentes e loop

| # | Candidato | Origem | Destino | Score |
|---|---|---|---|---:|
| 1 | State machine de operações (passos plugáveis) | Goose `crates/goose-agent/src/machine.rs:45-267` | `src/core/agent/state-machine.ts` | 25 |
| 2 | Runner de um passo por chamada, com retomada | OpenCode `packages/core/src/session/runner/llm.ts:185-332` | `src/core/agent/runner.ts` | 25 |
| 3 | Inbox durável `queue`/`steer` | OpenCode `packages/core/src/session/inbox.ts:45-108` | `src/core/session/inbox.ts` | 24 |
| 4 | Repo map por PageRank | Aider `aider/repomap.py:365-629` | `src/core/code-intelligence/repomap.ts` | 24 |
| 5 | Compactação com checkpoint estruturado | OpenCode `packages/core/src/session/compaction.ts:159-231` | `src/core/agent/compaction.ts` | 24 |
| 6 | `apply_patch` freeform com gramática | Open Interpreter `codex-rs/core/assets/tools/apply_patch.lark:1-19` | `src/core/tools/apply-patch/` | 24 |
| 7 | Permissão como tupla `{action, resource, effect}` | Kilo `packages/schema/src/permission.ts:40-64` | `src/core/permissions/model.ts` | 24 |
| 8 | Entrega em dois estágios com review | SWE-agent `tools/review_on_submit_m/bin/submit:23-46` | `src/core/tools/submit-review.ts` | 24 |

### Orquestração

| # | Candidato | Origem | Destino | Score |
|---|---|---|---|---:|
| 1 | Journal de operações duráveis | Pydantic AI `pydantic_ai/durable_exec/_operation.py:249-307` | `src/core/session/run-journal.ts` | 25 |
| 2 | Interrupt/resume tipado por task | LangGraph `types.py:833,903` | `src/core/agent/interrupts.ts` | 24 |
| 3 | Checkpoint com `versions_seen` + `pending_writes` | LangGraph `checkpoint/base/__init__.py:93` | `src/core/session/run-journal.ts` | 23 |
| 4 | Política de HITL por step | Agno `workflow/types.py:20-61` | `src/core/agent/graph.ts` | 23 |
| 5 | Aprovação por predicado (vê ctx/tool/args) | Pydantic AI `toolsets/approval_required.py:14-24` | `src/core/security/permissions.ts` | 22 |

### MCP

| # | Candidato | Origem | Destino | Score |
|---|---|---|---|---:|
| 1 | Streamable HTTP/SSE com sessão, `Last-Event-ID` e backoff | TS SDK `packages/client/src/client/streamableHttp.ts:343-900` | `src/core/mcp/transport/http.ts` | 25 |
| 2 | OAuth 2.1 (PRM/ASM, PKCE, RFC 8707/9207) | Python SDK `src/mcp/client/auth/oauth2.py:292-791` | `src/core/mcp/auth.ts` | 24 |
| 3 | Guard de caminho anti-TOCTOU | servers `src/filesystem/path-validation.ts:12-93` | `src/core/security/path-guard.ts` | 23 |
| 4 | Lifecycle stdio com kill de árvore | Python SDK `src/mcp/client/stdio.py:116-302` | `src/core/mcp/transport/stdio.ts` | 23 |
| 5 | Negociação de era + `server/discover` | TS SDK `versionNegotiation.ts:90-200` | `src/core/mcp/negotiation.ts` | 22 |

### Computer Use

| # | Candidato | Origem | Destino | Score |
|---|---|---|---|---:|
| 1 | `return_state` + settle por observação | munim `settle.rs:38-228` | `src/core/computer/settle.ts` | 25 |
| 2 | Backend MCP alternativo (32 tools) | munim `main.rs:252-487` | `src/core/computer/layer.ts` | 25 |
| 3 | Mapa de captura + aviso de cor única | munim `capture.rs:174-214` | `src/core/computer/layer.ts` | 24 |
| 4 | Política app/site allow/ask/block | munim `policy.rs:1-212` | `src/core/security/computer-policy.ts` | 24 |
| 5 | Rechecagem de fingerprint do elemento | munim `windows.rs:154-181` | `src/core/computer/layer.ts` | 23 |
| 6 | Mapa de teclas/VK completo | pyautogui `_pyautogui_win.py:113-247` | `src/core/computer/keymap.ts` | 22 |
| 7 | Ranking/NMS da árvore de acessibilidade | win-computer-use `markers.py:146-191` | `src/core/computer/snapshot-rank.ts` | 19 |

### Navegador

| # | Candidato | Origem | Destino | Score |
|---|---|---|---|---:|
| 1 | Snapshot híbrido AX+DOM com `xpathMap` | Stagehand `a11y/snapshot/capture.ts:43-72` | `src/core/browser/snapshot/capture.ts` | 25 |
| 2 | Snapshot ARIA "modo IA" + `aria-ref` | Playwright `injected/src/ariaSnapshot.ts:25-93` | `src/core/browser/snapshot/aria.ts` | 25 |
| 3 | ID `frame-backendNodeId` + ref estável | Stagehand `treeFormatUtils.ts:8-14` | `src/core/browser/ref.ts` | 24 |
| 4 | Resolução polimórfica de alvo | Playwright `tools/backend/tab.ts:578-644` | `src/core/browser/target.ts` | 24 |
| 5 | Escada de identidade de elemento | browser-use `dom/views.py:165-185` | `src/core/browser/element-identity.ts` | 24 |

### Modelos e roteamento

| # | Candidato | Origem | Destino | Score |
|---|---|---|---|---:|
| 1 | Contrato `LanguageModelV4` | Vercel AI `provider/src/language-model/v4/language-model-v4.ts:46-58` | `src/core/providers/types.ts` | 25 |
| 2 | Auto-parser de tool call por família | llama.cpp `common/chat-auto-parser.h:48-60` | `src/core/providers/tool-parse.ts` | 24 |
| 3 | Descoberta por capabilities (`/api/show`) | Ollama `server/routes.go:1745-1960` | `src/core/providers/discovery.ts` | 24 |
| 4 | Catálogo com `supportedParameters` e preço | OpenRouter `src/models/model.ts:46-127` | `src/core/providers/catalog.ts` | 23 |
| 5 | Usage com cache read/write + reasoning | Vercel AI `packages/ai/src/types/usage.ts:10-59` | `src/shared/types.ts` | 23 |
| 6 | Retry com `Retry-After` | Vercel AI `retry-with-exponential-backoff.ts:10-95` | `src/core/providers/http.ts` | 22 |

### Análise de código

| # | Candidato | Origem | Destino | Score |
|---|---|---|---|---:|
| 1 | `metaModel.json` como fonte de tipos LSP | LSP `metaModel.json:1-4` | `src/shared/lsp/` (gerado) | 20 |
| 2 | Schema declarativo de regra AST | ast-grep `crates/config/src/rule_config.rs:84` | `src/core/quality/rules/schema.ts` | 19 |
| 3 | Precedência de ignore em 7 passos | ripgrep `crates/ignore/src/walk.rs:454-486` | `src/core/util/ignore-rules.ts` | 18 |
| 4 | `positionEncoding` explícito | LSP `types/position.md:23-63` | `src/core/lsp/position.ts` | 18 |
| 5 | Padrão AST com metavar + ellipsis | ast-grep `crates/core/src/matcher/pattern.rs:355` | `src/core/code-intelligence/patterns.ts` | 18 |

### Memória

| # | Candidato | Origem | Destino | Score |
|---|---|---|---|---:|
| 1 | Waterfall de memória com orçamento de tokens | LlamaIndex `memory/memory.py:672-809` | `src/core/agent/compaction.ts` | 18 |
| 2 | Extração ADD-only + dedup por hash | Mem0 `memory/main.py:918-1041` | `src/core/memory/extract.ts` | 18 |
| 3 | Bloco de fatos com condensação segura | LlamaIndex `memory_blocks/fact.py:119-167` | `src/core/memory/facts.ts` | 16 |
| 4 | Prompt de extração com data de observação | Mem0 `configs/prompts.py:468-540` | `src/core/memory/prompts.ts` | 16 |

### UI desktop

| # | Candidato | Origem | Destino | Score |
|---|---|---|---|---:|
| 1 | Flow control de PTY com ACK | Terax `src-tauri/src/modules/pty/output.rs:11-73` | `src/main/terminal/flow.ts` | 24 |
| 2 | Renderer WebGL com fallback | xterm.js `addons/addon-webgl/src/WebglAddon.ts:51-84` | `src/renderer/.../terminal/webgl.ts` | 23 |
| 3 | SSRF guard (DNS pinado + redirect) | Terax `modules/net/ip.rs:1-110` | `src/core/net/guard.ts` | 23 |
| 4 | Shell integration OSC 7/133 | Terax `modules/pty/shell_init.rs:9-20` | `src/main/terminal/integration.ts` | 22 |
| 5 | Path guard canônico | Terax `modules/ai/lib/security.ts:265-322` | `src/core/security/path.ts` | 22 |

### Testes e observabilidade

| # | Candidato | Origem | Destino | Score |
|---|---|---|---|---:|
| 1 | Taxonomia trace/observation + usage/cost | Langfuse `shared/src/domain/observations.ts:9-107` | `src/core/observability/types.ts` | 24 |
| 2 | Retry de export OTLP (dependência) | OTel JS `retrying-transport.ts:10-103` | `@opentelemetry/*` | 24 |
| 3 | Assertions de trajetória | promptfoo `src/assertions/trajectory.ts:130-600` | `src/core/eval/assertions/trajectory.ts` | 24 |
| 4 | Correção de tools determinística | DeepEval `tool_correctness.py:474-621` | `src/core/eval/metrics/tool-correctness.ts` | 23 |
| 5 | Detecção de loop de agente | DeepEval `agent_loop_detection.py:65-258` | `src/core/eval/metrics/agent-loop.ts` | 22 |

### 2.1. Assets colhidos (para poder apagar os clones)

`scripts/harvest-research-assets.mjs` gerou `resources/harvested/`:

| Tipo | Quantidade | Onde |
|---|---:|---|
| skills | 387 | `resources/harvested/skills/` |
| agentes | 21 | `resources/harvested/agents/` |
| comandos | 23 | `resources/harvested/commands/` |
| prompts | 168 | `resources/harvested/prompts/` |
| fontes de ferramentas | 25 | `resources/harvested/tools/sources/` |

O manifesto com origem, commit, licença, hash e qualidade está em
`resources/harvested/manifest.json`. Foram excluídos `zed`, `claw-code-local`,
`Mcp.ComputerUse`, `wisprflow` e pastas `ee/`/`enterprise/`.

Para o runtime foram promovidos:

- **5 skills**: `agent-delegation`, `structured-debugging`, `e2e-testing`,
  `create-pull-request`, `harness-eval`.
- **5 agentes**: `test-engineer`, `css-specialist`,
  `playwright-test-generator`, `playwright-test-healer`,
  `playwright-test-planner`.

O restante fica como arquivo de referência e não entra no contexto do modelo.

## 3. Fila de implementação

Ordem por dependência e risco. Uma fatia por vez, com teste e build.

| # | Fatia | Base | Destino | Estado |
|---|---|---|---|---:|
| 1 | Settle pós-ação + relatório de estabilidade | munim | `src/core/computer/settle.ts` | **feito** |
| 2 | Contrato de provider + usage/custo + retry | Vercel/LiteLLM/OpenRouter | `src/core/providers/*` | próximo |
| 3 | Permissões por tupla/regra + aridade de shell | Kilo/Qwen/Goose | `src/core/security/*` | |
| 4 | `apply_patch` + leitura prévia obrigatória | Open Interpreter/Qwen | `src/core/tools/*` | |
| 5 | Runner de um passo + journal durável | OpenCode/Pydantic | `src/core/agent/*` | |
| 6 | MCP HTTP/SSE + lifecycle + negociação | TS/Python SDK | `src/core/mcp/*` | |
| 7 | Repo map + regras AST + posição LSP | Aider/ast-grep/LSP | `src/core/code-intelligence/*` | |
| 8 | Snapshot de navegador com refs estáveis | Stagehand/Playwright | `src/core/browser/*` | |
| 9 | Extração de memória + orçamento de contexto | Mem0/LlamaIndex | `src/core/memory/*` | |
| 10 | Spans + eval de trajetória | Langfuse/promptfoo/DeepEval | `src/core/observability`, `src/core/eval` | |
| 11 | Flow control de PTY + shell integration | Terax/xterm | `src/main/terminal/*` | |
| 12 | Política de app/site + fingerprint + captura | munim | `src/core/security`, `src/core/computer` | |

## 4. Licenças — resumo operacional

| Grupo | Regra |
|---|---|
| MIT / Apache-2.0 / BSD / ISC | portar com copyright, texto da licença e aviso de alterações. |
| `universal-ctags` (GPL-2.0) | não copiar; usar binário/CLI ou reimplementar. |
| `zed` (GPL-3.0 em 207 crates, Apache em 36) | só crates Apache; o resto é ideia/clean-room. |
| `eclipse.jdt.ls` (EPL-2.0) | não copiar; usar como serviço externo. |
| `langfuse` (MIT + `ee/` proprietário) | só fora de `ee/`. |
| `claw-code-local`, `Mcp.ComputerUse` (sem licença) | nenhum código; só conceito. |

## 5. O que já foi implementado nesta rodada

`src/core/computer/settle.ts` + `tests/computer-settle.test.ts`:
algoritmo de quietude adaptado do `munim-computer-use` (`settle.rs`), com
relógio injetável, teste de reação, timeout e ausência de linha de base. O
settle é **opt-in**: `ComputerLayer.elementAction` faz uma única leitura
pós-ação por padrão e só usa `snapshotSettled` quando a ferramenta recebe
`observe_after: true`; nesse caso reporta `settle_ms`, `settle_reacted` e
`settle_timed_out`. O probe é por polling de snapshot, não por WinEvents, e
pode atingir o teto em apps com animação contínua.

Verificação real:

```powershell
npm run typecheck        # limpo
npx vitest run           # 53 arquivos, 815/815 testes
npm run build            # Electron main + preload + renderer
```

Procedência e licença em [`CODE_PROVENANCE.md`](./CODE_PROVENANCE.md) e
`THIRD_PARTY_NOTICES.md` §4.2.

## 6. Próximo passo recomendado

Fatia 2: contrato de provider + usage/custo + retry. É a base que destrava
modelos, custo por turno e observabilidade; os três clones (Vercel AI, LiteLLM,
OpenRouter) são TypeScript ou têm schema portável, e o risco é baixo porque o
runner atual continua funcionando durante a migração.
