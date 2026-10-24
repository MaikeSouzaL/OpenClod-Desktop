# Inventário de repositórios

Verificação feita em **2026-10-23** via API do GitHub e leitura dos arquivos dos
próprios repositórios (README, licença, árvore de arquivos). Nenhum dado abaixo
foi presumido a partir do prompt original: todos os repositórios e licenças
foram conferidos individualmente.

> **Atualização 2026-10-23 (tarde):** os 8 repositórios foram clonados em
> [`repositorios/`](../../repositorios/README.md) e estudados pelo código-fonte.
> A seção "Estudo do código-fonte" abaixo traz os fatos verificados nos clones
> (com caminhos), que substituem as impressões tiradas só do README.

## Resumo

| Projeto | URL | Licença | Linguagem | Arquivos | Estado | Decisão |
|---|---|---|---|---|---|---|
| cdesktop | github.com/cdesktop-ai/cdesktop | Apache-2.0 | Rust + React | 2.776 | ativo (push 2026-05-19), beta | **referência de UX + estudo de arquitetura** |
| OpenHarness | github.com/pokkai/openharness | MIT | Python | 539 | ativo (push 2026-04-29) | **referência de harness** (porta seletiva de ideias) |
| REA | github.com/morluto/rea | MIT | TypeScript | — | muito ativo (push 2026-10-23), v6.7.0 | **ferramenta usada na Fase 2** |
| OpenCode | github.com/anomalyco/opencode | MIT | TypeScript | — | muito ativo (push 2026-10-23) | **referência de harness + este próprio ambiente** |
| DeepSeek Harness | github.com/deepseek-ai/deepseek-harness | MIT | TypeScript | — | ativo (push 2026-10-17) | **referência de plugins** |
| Claw Code Local | github.com/codetwentyfive/claw-code-local | **sem licença** | Rust | 314 | ativo (push 2026-09-17) | **não reutilizável** (all rights reserved) |
| Mcp.ComputerUse | github.com/tdav/Mcp.ComputerUse | **sem licença** | C# | 52 | v0.1.0, 0 estrelas | **não reutilizável** (all rights reserved) |
| open-computer-use | github.com/opensymph/open-computer-use | MIT | Swift/Go/TS | 271 | ativo (push 2026-10-17), v1.3.0 | **integrado** (backend de Computer Use) |
| ai-memory | github.com/akitaonrails/ai-memory | MIT | Rust | 1.257 | ativo (v3.2.2, commit `1bd8663`) | **modelo implementado nativamente** (wiki markdown + handoffs por projeto); binário oficial opcional por MCP |
| Wispr Flow | wisprflow.ai (instalador + payload) | proprietário | Electron + .NET | 963 no payload | v1.6.1253 | **só comportamento observável** via REA; nenhum código copiado |

## Detalhes por projeto

### A. cdesktop (`cdesktop-ai/cdesktop`)

- **O que é, de fato:** um *web UI* (`npx cdesktop`) para **5 agentes CLI já
  instalados** — Claude Code, Codex, Gemini CLI, OpenCode e Hermes. O harness
  não é dele: cada agente roda como **processo filho** e o cdesktop faz o
  streaming, o histórico e os diffs.
- **Stack:** backend Rust com ~40 crates (`server`, `db`, `executors`,
  `worktree-manager`, `git`, `git-host`, `mcp`, `preview-proxy`, `tauri-app`,
  `relay-*`), frontend React + Vite + Tailwind + shadcn + CodeMirror +
  `git-diff-view` + Lexical.
- **Recursos observados na árvore:** sessões em paralelo (até 4 células),
  worktrees opcionais por projeto, revisão de diff com comentários inline,
  preview de app com devtools/device emulation, PRs, rotinas agendadas, times
  de agentes (`cdesktop team spawn`), 20+ presets de provedor, i18n.
- **Limitações relevantes:** app desktop (Tauri) "wired up but not yet
  shipped"; é beta; o valor está em orquestrar CLIs de terceiros — depende de
  assinaturas/credenciais desses CLIs.
- **Decisão:** **não fazer fork**. Ver `ARCHITECTURE.md` §2. Reutilizar a
  *linguagem visual de produto* (sidebar de sessões, transcript com terminal e
  diff, painel direito) e os padrões de interação, com identidade própria.
  Razões: (1) acoplar nosso harness a um app Rust de 2.776 arquivos exigiria
  reescrever a camada de executores e arrastar `relay-*`/`remote` sem uso;
  (2) a UI é a parte de menor risco e maior valor de controle; (3) o produto
  depende de CLIs externos, o que contradiz o requisito de harness próprio.

### B. OpenHarness (`pokkai/openharness`)

- **O que é:** infraestrutura de agente em Python (≥3.10) + TUI React/Ink +
  agente pessoal `ohmo` (Feishu/Slack/Telegram/Discord). MIT.
- **Módulos presentes em `src/openharness/`:** `engine`, `tools`, `skills`,
  `memory`, `hooks`, `permissions`, `sandbox`, `coordinator`, `swarm`,
  `mcp`, `plugins`, `tasks`, `auth`, `bridge`, `channels`, `state`,
  `prompts`, `commands`.
- **Testes:** 30 diretórios em `tests/` (engine, permissions, hooks, skills,
  memory, mcp, sandbox, swarm, coordinator, tasks, tools, ...). O README
  declara 114 testes passando e 6 suítes E2E; **não executamos a suíte**
  (fora do escopo desta fase e sem necessidade para a decisão).
- **Decisão:** **referência arquitetural**, não dependência. Portar *conceitos*
  (hooks before/after tool, permissões por ferramenta, compactação,
  coordenação de subagentes) para TypeScript, sem copiar código. Um sidecar
  Python aumentaria a superfície de instalação e criaria dois runtimes.

### C. REA (`morluto/rea`)

- **O que é:** CLI + MCP server de engenharia reversa (binários nativos,
  aplicações JavaScript/Electron, .NET, Android, web). MIT, v6.7.0.
- **Capacidades confirmadas nesta máquina:** `rea doctor` executou; análise
  estática de JavaScript/Electron funciona **sem** Hopper/Ghidra/IDA
  (`missing_analysis_engine` apenas para binário nativo).
- **Uso neste projeto:** `analyze-javascript-application` sobre o `app.asar` do
  Claude Desktop. Ver `CLAUDE_DESKTOP_OBSERVATIONS.md`.
- **Limite importante:** REA reconstrói *estrutura e evidência*, não recupera
  código-fonte proprietário. O bundle analisado não expôs texto de código nos
  nós do grafo — apenas estrutura (endpoints, rotas, binds, requires).

### D. Outros harnesses

- **OpenCode** (MIT, TypeScript): harness completo com agentes, ferramentas,
  MCP, LSP, TUI. É o ambiente em que este trabalho está sendo executado.
  Usado como **referência de padrões** (permissões, agent loop, MCP).
- **DeepSeek Harness** (MIT, TypeScript, Electron): "everything is a plugin".
  O `app.asar` instalado tem 14.846 fontes JS (inclui `node_modules`).
  A análise com REA excedeu 120 s e foi interrompida sem resultado — registrado
  como **inconclusivo**, não como "analisado".
- **Claw Code Local** (Rust): reimplementação clean-room de um harness estilo
  Claude Code, com 130+ slash commands. **Sem arquivo LICENSE** (verificado:
  `GET /LICENSE` → 404 e a raiz do repo não contém LICENSE). Código
  **não pode ser reutilizado**; serve apenas como referência conceitual de
  paridade de comandos.

### E. Computer Use

- **open-computer-use** (MIT) — escolhido. Backend Windows em **Go**
  (`native_uia.go`, `native_win32.go`, `native_capture.go`), com UI Automation
  primeiro e Win32 como fallback. Verificado nesta máquina:
  `list-apps`, `list_windows`, `get_app_state` (árvore + `element_index`) e
  `cursor-position` funcionam; `screenshot` do próprio utilitário falhou com
  `GetDIBits failed`, então a captura é feita por GDI nativo próprio.
- **Mcp.ComputerUse** (C#) — arquitetura boa (DPI Per-Monitor V2, remapeamento
  de coordenadas, AOT), mas **sem licença** e v0.1.0. Não reutilizável.
  As ideias de DPI/coordenadas foram reimplementadas de forma independente.

## Estudo do código-fonte (clones de 2026-10-23)

Leitura direta dos clones em `repositorios/`. Nada foi executado. Caminhos
relativos à pasta de cada repositório. As correções em relação à rodada
anterior estão marcadas com **(corrige)**.

### opencode — `0749dec`, MIT

- Está na v2.1.4 com núcleo reescrito sobre **Effect v4** e Bun; não usa mais
  o Vercel ai-sdk como base. Copiar código direto exige arrastar Effect; o que
  vale trazer são **dados e tabelas**, reimplementados em TS simples.
- Provedores: SDK próprio em `packages/ai/src/providers/*` (cerca de 50) com
  protocolos `openai-chat`, `openai-responses`, `anthropic-messages`, `gemini`,
  `bedrock-converse`, `openai-compatible-chat`.
- Catálogo de modelos: `packages/core/src/models-dev.ts` lê
  `https://models.opencode.ai/api.json`; snapshot embutido com 230 provedores
  e 8.848 modelos (contexto, saída, custo com cache, `tool_call`, `reasoning`,
  `interleaved`, `temperature`, modalidades). Termos de uso dos dados: **não
  verificados**.
- Compatibilidade por modelo: `packages/schema/src/model-compatibility.ts`
  (`reasoningField`, `maxTokensField`, `requireAssistantAfterTool`,
  `cacheFormat`…). O raciocínio é reenviado ao Kimi/DeepSeek quando o modelo
  exige.
- Erros e retry: `packages/ai/src/provider-error.ts` (cerca de 20 regex por
  provedor para rate limit, quota, auth e estouro de contexto) e
  `packages/core/src/model-retry.ts` (2–10 s exponencial, `retry-after` até
  15 min). Timeouts de 300 s no cabeçalho e 900 s entre pedaços do stream.
- Loop: ferramentas começam a rodar ao chegar o evento `tool-call`, ainda
  durante o stream; continuação automática quando a resposta é cortada por
  `length`; último passo pede resumo com `toolChoice: none`.
- Edição (`tool/plugin/edit.ts`): match exato → normalização de aspas,
  travessões e espaços → espaços no fim da linha; preserva CRLF.
- Permissões: regras `{action, resource, effect}`, vale a última que casar,
  salvas em SQLite; shell analisado com tree-sitter (bash e PowerShell).
- Compactação: reserva 15% ou 16k, preserva 15k recentes, template estruturado
  (Objective, Requirements, Decisions, Work State, Next Move, Relevant Files).
- Descoberta de modelos locais: Ollama (`/api/tags` + `/api/show`) e LM Studio
  (`/api/v1/models`).
- Servidor HTTP + SSE com OpenAPI de 149 operações; desktop Electron 44.

### openharness — `1bcdc62`, MIT

- Loop (`src/openharness/engine/query.py`): compacta antes de cada turno e,
  se o provedor responder "prompt too long", compacta e repete uma vez;
  ferramentas em paralelo com erro por ferramenta; saídas grandes vão para
  arquivo e o modelo recebe uma prévia.
- Hooks (`hooks/`): 10 eventos (session_start/end, pre/post_compact,
  pre/post_tool_use, user_prompt_submit, notification, stop, subagent_stop) e 4
  tipos (`command`, `http`, `prompt`, `agent`), com matcher glob e timeout.
- Permissões (`permissions/checker.py`): modos default/plan/full_auto; caminhos
  sensíveis (`~/.ssh`, `.aws`, `.kube`…) bloqueados mesmo em full_auto; regras
  glob de caminho e comando.
- Compactação em camadas (`services/compact/__init__.py`, 1.696 linhas):
  microcompact, session-memory, context-collapse e resumo por LLM; reanexa
  arquivos recentes, plano e skills depois.
- Tarefas em background (`tasks/manager.py`) com log por tarefa e ferramentas
  `task_create/get/list/output/stop/update`.
- 21 provedores em `api/registry.py` (3 backends: anthropic, openai_compat,
  copilot). Cerca de 820 funções de teste. **Atenção:** 4 testes de API real
  têm uma string com formato de chave como valor padrão; não copiar esses
  arquivos.

### cdesktop — `75bd015`, Apache-2.0 (+ `NOTICE`: deriva do vibe-kanban; catálogo de provedores do cc-switch, MIT)

- É uma UI web (axum + React) sobre **agentes CLI de terceiros**. Interface
  comum `StandardCodingAgentExecutor` em
  `crates/executors/src/executors/mod.rs` (ClaudeCode, Codex, Gemini, Opencode,
  Cursor, Qwen, Copilot, Droid, DeepseekTui, Hermes, Amp).
- Claude Code: `claude -p --verbose --output-format=stream-json
  --input-format=stream-json --include-partial-messages --replay-user-messages
  --permission-prompt-tool=stdio …` (`executors/claude.rs:152-205`); cada
  mensagem seguinte abre processo novo com `--resume`; protocolo de controle em
  `claude/protocol.rs` (`can_use_tool`, `hook_callback`, `set_permission_mode`).
  Mesma família de protocolo que o Claude Desktop usa.
- Codex via `codex app-server` (JSON-RPC); Gemini e Hermes via ACP; OpenCode via
  `opencode serve` + HTTP. Normalização de logs para um formato único
  (`logs/mod.rs`).
- **Cuidado:** `crates/executors/default_profiles.json` vem com permissões
  liberadas (`dangerously_skip_permissions: true`).
- Worktrees (`crates/worktree-manager`), PTY (`portable-pty` + xterm), preview
  por proxy de subdomínio com devtools injetado, diff com comentários por linha
  que viram markdown no composer, SQLite com 82 migrations, grade de até 4
  sessões (`cells/SessionGrid.tsx`).

### deepseek-harness — `22ddee37`, MIT **(corrige: é TypeScript/Electron com código-fonte disponível; a rodada anterior só tinha olhado o asar instalado)**

- "Tudo é plugin" sobre o Cordis (`docs/architecture.md`); loop em
  `core/agent-loop` com eventos `agent/pre-step → llm/stream →
  tools/pre-execute → tools/post-execute`.
- Provedores: `llm-deepseek` e `llm-pi-ai` (multi-provedor via
  `@earendil-works/pi-ai`), `llm-retry`, `token-meter`.
- Executa **Claude Code e Codex como subagentes** (`subagent-claude-code` usa
  `@anthropic-ai/claude-agent-sdk`; `subagent-codex` usa `codex app-server`) e
  roda `hooks.json` do Claude Code (`experimental/hooks-claude-code`).
- Permissões: presets que juntam sandbox e aprovação; aprovação que falha
  fechada; confinamento de escrita no Windows por ACL e integridade Low
  (`sandbox/sandbox-windows-acl`).
- UI: docking de painéis (`client/ui-dockkit`, declarado independente), xterm 6
  com recuperação de processos, navegador por `<webview>`, PTY via node-pty.

### claw-code-local — `f4cc5d7` (1 commit), **sem arquivo LICENSE** **(corrige: o commit clonado é de 2026-04-03)**

- Declara MIT só no `README.md` e no `Cargo.toml`; sem arquivo de licença,
  tratamos como todos os direitos reservados.
- Conceitos úteis: protocolo de hooks com exit 0/2 + JSON
  (`permissionDecision`, `updatedInput`) em `runtime/src/hooks.rs`; regras
  `Tool(subject)` em listas deny > ask > allow (`runtime/src/permissions.rs`);
  143 especificações de slash command, das quais cerca de 27 funcionam.

### open-computer-use — `e551c13`, MIT

- Backend Windows em Go (`apps/OpenComputerUseWindows`): UIA por COM, entrada
  por SendInput/PostMessage, captura WGC → PrintWindow → GDI. 14 ferramentas;
  modo `mcp` (stdio) e `call`.
- **O cache de snapshot vive só na memória do processo**
  (`main.go:811-823`): ação por `element_index` exige `get_app_state` antes
  **no mesmo processo**. Verificado aqui: `open-computer-use call click` num
  processo novo responde "No app state is available… Run get_app_state before
  action tools" com `isError: true`.
- Travas por variável de ambiente: `ALLOW_FOREGROUND_INPUT`,
  `ALLOW_APP_LAUNCH`, `ALLOW_FOCUS_ACTIONS`, `ALLOW_UIA_TEXT_FALLBACK`.
- Sem manifesto de DPI nem `SetProcessDpiAwareness*`.

### Mcp.ComputerUse — `41f6b5a`, **sem licença** ("Code license: not set yet")

- Referência de DPI Per-Monitor V2 (`Core/MonitorRegistry.cs`) e de
  remapeamento de coordenadas por monitor (`Core/CoordinateMapper.cs`,
  `ScalePlanCache.cs`). Sem UIA. Só como ideia.

### REA — `1de720e`, MIT

- O clone é **mais novo** que a instalação em uso (`Desktop\REA\rea`, 6.4.0,
  que é a que roda como MCP nesta máquina e tem Ghidra 12.1.4 configurado via
  `rea-local.json`). O clone tem ferramentas que a 6.4.0 não expõe, como
  `inspect_electron_fuses`.
- O `package.json` do clone pede Node `^22.23.4 || ^24.22.1 || >=26.12.1`; o
  Node desta máquina é 22.22.1.
- Integração recomendada no Openclod: MCP stdio pelo `McpClient` existente, com
  filtro de ferramentas (leitura liberada; `capture_electron_scenario` só com
  aprovação) e timeout maior (≥ 180 s).

### F. ai-memory (`akitaonrails/ai-memory`)

- **O que é:** binário Rust único de memória de longo prazo para agentes, com
  wiki markdown em git como fonte da verdade, SQLite FTS5 como índice derivado,
  captura por hooks, 24 ferramentas MCP, handoffs claim-once e isolamento por
  `(workspace, project, path)`. MIT, v3.2.2.
- **O que foi aproveitado:** o *modelo* (wiki markdown por projeto, índice
  reconstruível, briefing limitado, busca, páginas e handoffs claim-once) foi
  implementado em TypeScript em `src/core/memory/project.ts` e
  `src/core/memory/tools.ts`; a UI está em Configurações → Memória.
- **O que não foi copiado:** o código Rust, o servidor HTTP, o SQLite/FTS5, o
  aging por decay e a consolidação por LLM. O binário oficial pode ser ligado
  como servidor MCP (`ai-memory mcp-bridge`), documentado em
  [`AI_MEMORY.md`](AI_MEMORY.md).
- **Limitação registrada:** a busca do Openclod é lexical (sem BM25/vetores) e não
  há captura automática de cada tool call nesta versão.

### G. Wispr Flow (`wispr-flow` / `WisprFlowInstaller.exe`)

- **O que é:** app proprietário de ditado (Electron 42 + helper .NET), com
  atalho global, pílula flutuante, transcrição em streaming (Opus/WebSocket),
  polish por LLM e inserção via UI Automation/clipboard. Distribuição Squirrel;
  instalador .NET NativeAOT baixa o payload de `dl.wisprflow.com`.
- **Como foi estudado:** REA 6.4.0 (artefato/PE), 7-Zip, leitura estática do
  `app.asar` (131 MB) e strings do helper. Evidências em
  [`WISPR_FLOW.md`](WISPR_FLOW.md).
- **O que foi implementado:** atalho global configurável, pílula always-on-top,
  microfone + Whisper local, inserção no compositor ou em qualquer app
  (clipboard + Ctrl+V), polish opcional e o mesmo fluxo no botão de microfone.
- **O que foi descartado:** código/ícones/prompts proprietários, backend em
  nuvem, telemetria Sentry/PostHog, auth Supabase/WorkOS e o helper .NET. O
  modo "segurar" fica pendente de um hook nativo de teclado.

## O que foi deliberadamente descartado

- Fork do cdesktop (custo de integração > benefício; harness de terceiros).
- Sidecar Python do OpenHarness (dois runtimes, instalador frágil).
- Qualquer código de Claw Code Local ou Mcp.ComputerUse (licença ausente).
- Copiar código do Claude Code / Claude Desktop (proprietário). A análise
  produziu apenas **fatos de comportamento e identificadores**, não código.
