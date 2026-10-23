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
