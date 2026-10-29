# Matriz de funcionalidades

Legenda de maturidade: **A** = maduro e testado no projeto de origem,
**B** = funcional com lacunas, **C** = protótipo/parcial.
Decisão: **integrar** (dependência), **portar** (reimplementar conceito),
**referência** (só ideia), **descartar**.

| # | Funcionalidade | Origem | Evidência | Maturidade | Licença | Dependências | Compatibilidade | Decisão | Teste necessário |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Agent loop com tool calling em streaming | OpenHarness `engine/`, OpenCode | README + módulos | A | MIT | Python / TS | conceito | portar | loop com 3 iterações + tool calls; teste unitário |
| 2 | Execução paralela de ferramentas | OpenHarness | README ("Parallel Tool Execution") | B | MIT | — | direto | portar | 4 leituras concorrentes; garantir ordem de resultados |
| 3 | Retry com backoff em API | OpenHarness, cdesktop | README | A | MIT | — | direto | portar | simular 429/500 com servidor local |
| 4 | Compactação de contexto | OpenHarness, Claude Code (observado) | 28 menções a `compact` no bundle | B | MIT | — | direto | portar | encher contexto e verificar resumo + retomada |
| 5 | Memória persistente | OpenHarness `memory/` | módulo | B | MIT | — | direto | portar | salvar/buscar fato entre sessões |
| 6 | Skills sob demanda | OpenHarness `skills/`, OpenCode | módulos + `assets/skills` no cdesktop | A | MIT | — | direto | portar | carregar SKILL.md e injetar no contexto |
| 7 | Hooks de ciclo de vida | OpenHarness `hooks/` | módulo + testes | B | MIT | — | direto | portar | hook before/after tool dispara |
| 8 | Permissões por ferramenta | OpenHarness `permissions/`, OpenCode | módulos + testes | A | MIT | — | direto | portar | negar escrita em readonly; aprovar shell |
| 9 | Sandbox de execução | OpenHarness `sandbox/` | módulo | B | MIT | SO | parcial | portar (parcial) | comandos bloqueados + timeout |
| 10 | Subagentes / swarm | OpenHarness `swarm/`, `coordinator/` | módulos + testes | B | MIT | — | direto | portar | 2 subagentes paralelos sem conflito |
| 11 | MCP (cliente) | OpenHarness, OpenCode, cdesktop `crates/mcp` | módulos | A | MIT/Apache | — | direto | portar | cliente stdio contra servidor de teste |
| 12 | Sessões persistentes e retomada | cdesktop, OpenCode | crates `db`, `state` | A | Apache/MIT | — | direto | portar | matar app no meio e retomar |
| 13 | Worktrees por sessão | cdesktop `worktree-manager` | crate | A | Apache-2.0 | git | direto | referência (v2) | — |
| 14 | Diff com comentários inline | cdesktop | README + `review` crate | A | Apache-2.0 | — | — | referência de UX | diff renderizado no painel |
| 15 | Terminal integrado | cdesktop, OpenCode | README | A | Apache/MIT | PTY | parcial | portar (console, sem PTY) | executar comando e ver saída |
| 16 | Preview de app com devtools | cdesktop | README | A | Apache-2.0 | Chromium | — | referência | — |
| 17 | Presets de provedor (20+) | cdesktop | README | A | Apache-2.0 | — | direto | portar (8 presets) | trocar provedor e modelo por sessão |
| 18 | Computer Use Windows (UIA) | open-computer-use | `native_uia.go`, testado nesta máquina | A | MIT | binário nativo | **verificado** | **integrar** | abrir Notepad, clicar, digitar, verificar |
| 19 | Screenshot multi-monitor com DPI | open-computer-use, Mcp.ComputerUse | README + código | A | MIT / sem licença | GDI | direto | portar (GDI próprio) | captura 3840x1082 e downscale |
| 20 | Navegação web semântica | Playwright | docs oficiais | A | Apache-2.0 | Chrome/Edge | direto | **integrar** | abrir docs, clicar, preencher, screenshot |
| 21 | Pesquisa web | — | — | C | — | DuckDuckGo HTML | direto | implementar | consulta retorna resultados |
| 22 | Leitura de arquivos com números de linha | OpenCode/Claude Code (padrão) | comportamento observado | A | — | — | direto | implementar | ler arquivo e editar |
| 23 | Edição por substituição exata | OpenCode/Claude Code | comportamento observado | A | — | — | direto | implementar | edição única e ambígua (erro) |
| 24 | Busca por conteúdo (grep) | OpenCode | comportamento | A | — | — | direto | implementar | regex + include |
| 25 | Git status/diff/log/commit | cdesktop, OpenCode | crates | A | Apache/MIT | git | direto | implementar | diff e commit com aprovação |
| 26 | Execução de comandos com timeout | — | — | A | — | — | direto | implementar | timeout mata árvore de processos |
| 27 | Aprovação de ações sensíveis | Claude Code (observado), OpenHarness | 22 menções a `permission` | A | — | — | — | implementar | modal + bloqueio real |
| 28 | Proteção contra prompt injection | — | requisito do projeto | C | — | — | — | implementar | página com "ignore previous instructions" |
| 29 | Auditoria de operações | — | requisito | C | — | — | — | implementar | JSONL de eventos |
| 30 | Multi-provedor (OpenAI-compat + Anthropic) | cdesktop, OpenCode | presets | A | — | — | — | implementar | mesma tarefa em 2 modelos |
| 31 | Custo/consumo por sessão | OpenHarness | README ("Token Counting & Cost Tracking") | B | MIT | — | — | implementar | usage somado |
| 32 | Plan panel | cdesktop, OpenHarness | README | A | — | — | — | implementar | update_plan reflete na UI |
| 33 | Identidade visual própria | — | requisito | — | — | — | — | implementar | screenshots dos testes I |

## Lacunas conhecidas (não implementadas nesta versão)

| Lacuna | Motivo | Mitigação |
|---|---|---|
| Terminal com PTY real (vim, prompts interativos) | `node-pty` exige build nativo por versão do Electron | console de comandos com streaming e cancelamento; documentado |
| Worktrees automáticas por sessão | complexidade de estado git | isolamento por diretório; worktree manual via `git_checkout` |
| Editor de código embutido | custo alto, baixo retorno vs. diff viewer | visualização com números de linha + diff |
| Remote/relay (acesso pelo celular) | fora do escopo desktop local | — |
| Computer Use em macOS/Linux | backend nativo é Windows | camada abstrata pronta; `open-computer-use` cobre macOS |

## Atualização 2026-10-23 (voz, memória e equipe)

> As linhas acima são o retrato da primeira rodada. Esta seção registra o que foi
> implementado e verificado depois dela; onde houver conflito, vale esta seção.

| Recurso | Origem / decisão | Estado | Evidência |
|---|---|---|---|
| Ditado local com Whisper | faster-whisper + CTranslate2 + Silero VAD embutidos | **implementado** | `resources/stt/openclod_stt.py`, `src/main/stt.ts`; teste real `tiny` carregou em 2,7 s e transcreveu |
| Pílula flutuante estilo Wispr Flow | análise REA do app original; implementação própria | **implementado** | `src/main/dictation.ts`; UI verificada com `scripts/ui-mic-pill.cjs` |
| Atalho global + botão de microfone no mesmo motor | requisito do usuário | **implementado** | `dictation-store.ts`, `DictationHost.tsx`; `scripts/ui-wispr.cjs` inseriu no compositor |
| Inserção em qualquer app (clipboard + Ctrl+V) | comportamento observado no helper original | **implementado** | teste com Chrome: textarea recebeu `TESTE_EXTERNO_123` |
| Polish opcional | comportamento observado (Wispr) | **implementado** | `Orchestrator.polishText`, opt-in em Configurações → Voz |
| Memória por projeto (wiki markdown, briefing, handoffs) | modelo do ai-memory (MIT), implementação TS | **implementado** | `src/core/memory/project.ts`, `tools.ts`; 9 testes; UI Configurações → Memória |
| Busca em fatos + páginas | requisito do usuário | **implementado** | `memory_search` consulta os dois stores |
| Equipe / modo equipe | requisito do usuário | **implementado** | `settings.autoAgents` + esforço `max`; prompt "Modo equipe" |
| `agent-smith` + `create_agent` | requisito do usuário | **implementado** | cria `<userData>/agents/<nome>.md`; teste E2E registrou e listou o agente na mesma sessão |
| Pesquisa web em uma chamada | requisito do usuário | **implementado** | `web_research` (busca + lê fontes + URL por trecho); teste com fetch falso |
| Edição cirúrgica por diff | requisito do usuário | **implementado** | `patch_file` (diff unificado) + `edit_file`; testes de aplicação, dry-run e recusa |
| `CLAUDE.md` canônico criado automaticamente | requisito do usuário | **implementado** | `ensureProjectInstructions` em `context.ts`; chamado no init, addProject e ensureRunner; teste de não sobrescrita |
| Coluna única centralizada | correção de UI | **implementado** | thread/composer/plano/aprovação/fila/erro com o mesmo gutter; `ui-work.cjs` mediu centros iguais |
