# Análise do estado atual do Openclod — 2026-10-23

> **Atualização (mesmo dia, tarde):** os defeitos de §5 e mais um encontrado
> durante a correção (cofre de chaves) foram corrigidos e cobertos por testes.
> Ver §12. O que segue em §1–§11 é o retrato **antes** das correções.

Revisão da base criada na rodada anterior, feita com REA (análise do Claude
Desktop e do próprio Openclod), estudo do código-fonte dos 8 repositórios
clonados em `repositorios/`, execução do build e dos testes, e capturas de tela
do app rodando. Toda afirmação abaixo traz a evidência; o que não foi
verificado está marcado como tal.

## 1. Resumo

- **A base compila e os testes passam.** `npm run build` (typecheck + bundle)
  sem erros; `vitest`: 6 arquivos, **64 testes, todos verdes**. A UI abre e
  navega (capturas em `evidence/forja-ui-2026-10-23/`).
- **Nenhum teste de aceitação (A–J) foi executado com modelo real.** Não há
  credencial de provedor nesta máquina: nenhuma variável `*_API_KEY`, nenhum
  segredo salvo no Openclod, Ollama e LM Studio sem servidor ativo. O provedor
  padrão é o mock "Scripted". Isso é o principal bloqueio para validar o
  produto de ponta a ponta.
- **Foram encontrados 10 defeitos concretos**, 4 deles no Computer Use, que na
  prática **não funciona** no caminho por elemento nem por coordenada nesta
  máquina (§5).
- **A arquitetura difere da do Claude Desktop num ponto central:** lá, cada
  sessão Code é um **processo de harness separado** (`claude.exe` CLI) falando
  stream-json com a UI; no Openclod o harness roda **dentro do processo principal
  do Electron** (§4).
- **A superfície funcional é pequena perto do alvo:** o Openclod expõe 38 métodos
  IPC; o Claude Desktop expõe 1.400, sendo 352 só na interface `LocalSessions`
  da aba Code. Faltam terminal PTY, worktrees, Git/PR, hooks, plugins, rotinas,
  side chats, rewind, preview embutido e executores externos (§6, §8).
- **Recomendação:** corrigir os defeitos P0, conectar um provedor real e rodar
  os testes A–J antes de abrir novas superfícies; depois separar o harness em
  processo próprio com um protocolo de eventos, o que também habilita rodar
  Claude Code/Codex/OpenCode como executores (§10).

## 2. Como foi verificado

| Verificação | Comando / ferramenta | Resultado |
|---|---|---|
| Typecheck + build | `npm run build` | ok: `out/main` 212 kB, `out/preload` 4 kB, renderer 990 kB JS + 88 kB CSS |
| Testes | `npx vitest run` | 6 arquivos, 64 testes, 0 falhas (4,4 s) |
| Grafo da aplicação | REA `analyze_javascript_application` em `out/` | 1 `BrowserWindow`, 1 preload, 1 API no `contextBridge` com 8 membros, 11 operações IPC (canais dinâmicos via constantes), 5 handlers no main, 1 validação de remetente |
| Superfície IPC declarada | leitura de `src/shared/api.ts` | 38 canais `invoke` + 1 canal de eventos (`forja:event`) |
| UI | Electron com `--remote-debugging-port` + Playwright | Início, Cowork, Code, sessão com painel lateral e Configurações renderizam; 0 erros de console |
| Provedores disponíveis | variáveis de ambiente, `%APPDATA%\Openclod\config`, portas 11434/1234 | nenhuma chave; `secrets.bin` ausente; Ollama e LM Studio sem servidor |
| Computer Use | `open-computer-use call click` em processo novo | `isError: true`, "No app state is available… Run get_app_state" |
| Geometria de tela | `SystemInformation.VirtualScreen` | 2 monitores, desktop virtual 3840×1082 |
| Claude Desktop | REA MCP + `Get-CimInstance Win32_Process` | ver `CLAUDE_DESKTOP_OBSERVATIONS.md`, rodada 2 |
| Repositórios | 4 estudos de código em paralelo nos clones | ver `REPOSITORIES.md`, "Estudo do código-fonte" |

## 3. O que existe hoje

Código próprio: cerca de 18,5 mil linhas em `src/` (a maior parte em
`src/renderer/src/styles.css`, 5,4 mil, e `App.tsx`, 1,2 mil).

| Subsistema | Onde | Estado |
|---|---|---|
| Loop do agente | `src/core/agent/runner.ts` (`send()` tem ~450 linhas, 256–712) | funciona com o mock; limites de iteração/chamada/tempo/token/custo; detecção de chamada repetida 3×; paralelismo só se todas as ferramentas forem `parallelSafe` |
| Provedores | `src/core/providers/{openai,anthropic,http,presets}.ts` | 2 formatos de fio (Chat Completions e Anthropic Messages) + mock; 9 presets; retry em 408/409/429/5xx antes do stream |
| Ferramentas | `src/core/tools/*` | arquivos, busca, shell, git, web, navegador (10), Computer Use (12), plano, skills, memória, subagente |
| Permissões | `src/core/security/{policy,permissions}.ts` | 4 modos; blocklist de comandos; `WorkspaceGuard`; aprovação "sempre nesta sessão" em memória |
| Contexto | `src/core/agent/{context,compaction}.ts` | lê `AGENTS.md`/`CLAUDE.md`; compactação por LLM a 75% com fallback |
| Sessões | `src/core/session/store.ts` | JSON atômico + `events.jsonl`; export/import `forja.session.v1` |
| MCP | `src/core/mcp/client.ts` | stdio; só `tools/list` e `tools/call` |
| Navegador | `src/core/browser/layer.ts` | Playwright com Chrome/Edge do sistema; árvore ARIA; console/rede |
| Computer Use | `src/core/computer/layer.ts` | backend `open-computer-use` + captura GDI via PowerShell (defeitos em §5) |
| UI | `src/renderer/src/components/*` | sidebar com Início/Cowork/Code, transcript, composer, painel da sessão (contexto, plano, arquivos, alterações, "terminal", "navegador"), aprovações, configurações |
| Empacotamento | `electron-builder.yml` | NSIS x64 sem assinatura |

## 4. Arquitetura: Openclod × Claude Desktop

```
Claude Desktop (observado)                    Openclod (hoje)
──────────────────────────                    ────────────
Claude.exe (Electron)                         electron (main)
 ├─ UI: ion-dist (cliente web local)           ├─ UI: renderer React
 ├─ 1.400 métodos IPC tipados                  ├─ 38 métodos IPC
 ├─ claude.exe CLI  ← 1 por sessão Code        └─ SessionRunner (harness)  ← dentro do main
 │   (stream-json + control_request)               ├─ provedores
 │   └─ MCPs (filhos do CLI)                       ├─ ferramentas
 ├─ pty-host (node-pty/ConPTY)                     └─ MCP (filhos do main)
 ├─ workers (índice, busca, MCP runtime)
 └─ cowork-svc.exe (serviço + VM)
```

Consequências de manter o harness no processo principal:

1. Uma ferramenta travada ou um vazamento de memória derruba a janela inteira.
2. Não há como trocar o harness por outro (Claude Code, Codex, OpenCode) sem
   reescrever o orquestrador.
3. Sessões paralelas competem pelo mesmo event loop do main.

Proposta (detalhe em §10, P2): definir um **protocolo de eventos do Openclod**
(compatível em espírito com o stream-json do Claude Agent SDK: mensagens de
usuário/assistente, `tool_use`, `tool_result`, pedidos de permissão,
`control_request`/`control_response`), rodar o `SessionRunner` atual como
processo filho (`utilityProcess` do Electron) que fala esse protocolo, e
escrever adaptadores para executores externos. O cdesktop já prova o padrão
para 11 CLIs (`crates/executors`), e o deepseek-harness usa o
`@anthropic-ai/claude-agent-sdk` para o Claude Code.

## 5. Defeitos confirmados

Todos conferidos lendo o código; os itens 1 e 4 também conferidos em execução
nesta máquina.

| # | Defeito | Evidência | Impacto | Correção |
|---|---|---|---|---|
| 1 | Ações por `element_index` (clicar, `set_value`, digitar em elemento) falham | `computer/layer.ts:82` abre um processo novo do `open-computer-use` por chamada; o snapshot só existe na memória do processo (`repositorios/open-computer-use/apps/OpenComputerUseWindows/main.go:811-823`). Teste real: `call click` → `isError: true` | o caminho principal de Computer Use (acessibilidade) não funciona; teste C falha | manter o `open-computer-use` vivo em modo `mcp` via `McpClient`, ou usar `call --calls` com `get_app_state` + ação na mesma invocação |
| 2 | Erros do backend aparecem como sucesso | `tools/computer.ts:129,160,187,284,302` retornam `ok: true` sem olhar `isError` | o agente acha que clicou e segue em frente; viola "não declarar sucesso falso" | propagar `isError` como `ok: false` |
| 3 | `computer_activate` e `computer_launch` sempre falham | `layer.ts:204` manda `{window: <número>}` (o backend exige objeto); faltam `ALLOW_FOCUS_ACTIONS` e `ALLOW_APP_LAUNCH` (`layer.ts:198-204`) | não alterna janelas nem abre apps | corrigir o formato e ligar as travas só quando `allowComputerControl` estiver ativo |
| 4 | Cliques por coordenada caem no lugar errado | `layer.ts:228-249` reduz a captura para 1600 px; `clickAt`/`drag`/`moveTo` (`layer.ts:158-178`) repassam x/y sem conversão. Nesta máquina o desktop virtual tem 3840 px → erro de 2,4× | fallback visual inútil em multi-monitor ou tela maior que 1600 px | guardar origem e fator de cada captura e converter; preferir coordenadas relativas à janela (`get_window_state`) |
| 5 | `edit_file` corrompe texto com `$` | `tools/fs.ts:154` usa `before.replace(old, new)`; os padrões especiais de substituição (`$$`, `$&`, `$'` e cifrão seguido de crase) em `new_string` são interpretados | edições em shell, PHP, regex e templates saem erradas sem aviso | trocar por `split/join` ou função de substituição; teste com `$$` |
| 6 | Memória do projeto nunca entra no prompt | `agent/runner.ts:213` passa `memory: []` | fatos gravados com `memory_write` só aparecem se o modelo chamar `memory_search` | carregar a memória do projeto no `buildSystem()` |
| 7 | Permissões ignoram os argumentos | `security/permissions.ts:37` faz `void preview` | não há regra por padrão (ex.: permitir `npm test` mas perguntar `git push`), nem negação de arquivos sensíveis dentro do projeto (`.env`) | regras `ferramenta(padrão)` com allow/ask/deny e persistência por projeto |
| 8 | Padrão de autonomia contrário ao pedido | `%APPDATA%\Openclod\config\settings.json`: `mode: "ask"`, `allowComputerControl: false` | cada edição e comando pede aprovação, o oposto do "não interromper tarefas comuns" do prompt | oferecer modo autônomo (perguntar só em destrutivo/externo) como padrão de primeira execução, com confirmação explícita do usuário |
| 9 | Parâmetros fixos quebram alguns modelos | `providers/openai.ts:128` envia `temperature` 0,2 sempre e usa sempre `max_tokens`; raciocínio não é guardado nem reenviado | modelos que rejeitam `temperature` ou exigem `max_completion_tokens`/reenvio de `reasoning_content` (Kimi, DeepSeek reasoner, série o da OpenAI) falham | tabela de compatibilidade por modelo (ver opencode `model-compatibility.ts`) |
| 10 | Código morto e rótulos enganosos na UI | `components/RightPane.tsx` não é importado em lugar nenhum; a aba "Terminal" do painel é um log de atividade e "Navegador" mostra capturas | o usuário espera um terminal de verdade | remover `RightPane.tsx`; renomear para "Atividade" até existir PTY |

A investigar (não confirmado): a sessão "oi" mostra **OpenRouter
deepseek-chat** no cabeçalho e no rodapé, mas a resposta veio do provedor
**Scripted** (`evidence/forja-ui-2026-10-23/08-session-pane.png`). Pode ser
troca de modelo depois da mensagem ou um descompasso entre o modelo exibido e
o usado.

## 6. Cobertura dos requisitos do prompt mestre

Legenda: **sim** = existe e tem teste; **parcial** = existe com lacunas ou sem
teste; **não** = ausente. "Sem teste real" = nunca rodou com um modelo de
verdade.

| Requisito (seção do prompt) | Estado | Observação |
|---|---|---|
| Agent loop com streaming, cancelamento, limites (6.1) | parcial | testado com mock; sem continuação por `length`, sem compactação reativa a estouro de contexto, ferramentas só rodam após o fim do stream |
| Ferramentas de programação (6.2) | parcial | faltam LSP/símbolos, linters/formatadores como ferramenta, gerência de servidores de dev com leitura posterior de saída (`start_process` só captura durante `wait_ms`) |
| Modos Ask/Plan/Code/Debug/Review/Computer/Web/Autonomous (6.3) | parcial | os 8 modos existem como filtros de ferramentas; sem teste real |
| Contexto, memória, sessões (6.4) | parcial | defeito 6; sem fork, sem rewind/checkpoint, sem retomada de turno interrompido |
| Skills, hooks, comandos, MCP (6.5) | parcial | skills e MCP stdio ok; **hooks: não**; comandos personalizados: não; MCP sem HTTP/resources/prompts |
| Subagentes e paralelismo (7) | parcial | `task` síncrono, profundidade 1, não persistido, sem worktree |
| Camada de provedores (8) | parcial | 2 formatos + presets; sem catálogo de modelos, sem descoberta de modelos locais, sem cache de prompt, sem classificação de erro/`retry-after`, sem OpenAI Responses, sem Gemini nativo |
| Computer Use (4) | **quebrado** | defeitos 1–4; ver tabela abaixo |
| Navegação web (5) | parcial | Playwright funcional no código; não usa a sessão do Chrome do usuário (o Claude Desktop usa extensão + `chrome-native-host.exe`); sem teste real |
| Interface desktop (9) | parcial | faltam terminal PTY, diff com comentários, gestão de subagentes, configuração de skills, visualização das ações de Computer Use |
| Autonomia configurável (10) | parcial | defeito 8 |
| Testes (fase 6) | parcial | 64 testes unitários/integração do núcleo; nenhum E2E com modelo real; nada de UI automatizado |
| Empacotamento (fase 7) | parcial | NSIS sem assinatura; sem auto-update (documentado) |

Computer Use, item a item (lista da seção 4 do prompt):

| Capacidade | Estado |
|---|---|
| Capturar tela inteira | parcial (sem DPI explícito) |
| Capturar região/janela | não |
| Interpretar screenshot | sim (imagem vai ao modelo) |
| Mover, clicar, duplo, arrastar | quebrado (defeito 4) |
| Digitar e atalhos | sim |
| Identificar janelas/processos | parcial (`list_windows`; sem `list_apps` com pid) |
| Campos, menus, diálogos | quebrado (defeito 1); `perform_secondary_action` não exposto |
| Abrir aplicações | quebrado (defeito 3) |
| Alternar janelas | quebrado (defeito 3) |
| Esperar mudança de estado | parcial (só espera fixa) |
| Recuperar de erros | não (defeito 2) |
| Multi-monitor | parcial (uma imagem do desktop virtual inteiro) |
| Registrar ações | parcial (`events.jsonl`, sem antes/depois) |

## 7. Testes de aceitação (seção 13 do prompt)

| Teste | Situação | O que falta |
|---|---|---|
| A — Programação | não executado | provedor real |
| B — Navegação web | não executado | provedor real |
| C — Computer Use | **bloqueado por defeito** | defeitos 1–4 + provedor real |
| D — Depuração | não executado | provedor real |
| E — Continuidade | parcial | persistência testada em `session-store.test.ts`; retomada após reiniciar com modelo real não testada |
| F — Subagentes | não executado | provedor real; subagentes são síncronos |
| G — Segurança | parcial | `security.test.ts` (20 testes) cobre blocklist e guard; injeção por página web com modelo real não testada |
| H — Recuperação | parcial | retry 500 testado (`providers.test.ts`); timeout e falha de ferramenta com modelo real não testados |
| I — Qualidade visual | parcial | capturas desta rodada; sem critérios de aceitação visuais escritos |
| J — Portabilidade de modelos | não executado | dois provedores reais |

Opções de modelo já presentes nesta máquina (nenhuma em execução agora):
LM Studio instalado; modelos do Ollama em `~/.ollama` (`qwen3.5:4b` local,
mais 4 entradas `:cloud`), mas o executável do Ollama não foi encontrado em
`Programs`; FreeLLMAPI Desktop instalado. Um provedor de nuvem com chave
(Anthropic, OpenAI, DeepSeek, OpenRouter…) dá o resultado mais confiável para
A–J.

## 8. Paridade com o Claude Desktop

Mapeamento das interfaces observadas (rodada 2) para o Openclod:

| Área no Claude Desktop | Interface / evidência | Openclod |
|---|---|---|
| Ciclo de sessão, fila de mensagens, busca | `LocalSessions` (start, sendMessage, queue, search) | parcial: criar/enviar/abortar/arquivar; sem fila nem busca |
| Modelo, effort, fast mode, modo de permissão | `setModel`, `setEffort`, `setFastMode`, `setPermissionMode` | parcial: modelo e modo; sem effort |
| Contexto e compactação | `getContextUsage*`, "Compact session" | sim (painel de contexto + compactar) |
| Aprovação de ferramenta | `onToolPermissionRequest` / `respondToToolPermission` | sim (`ApprovalDock`) |
| Rewind / checkpoints | `rewind`, `rewindFiles`, `undoRewind` | não |
| Terminal PTY | `startShellPty`/`writeShellPty`/`resizeShellPty`, `pty-host` | não |
| Diff, commits, branches | `getGitDiff*`, `getGitCommits`, `stashWorkingTree` | parcial: aba de alterações em `<pre>` |
| PR e auto-fix | `getPrOverview`, `mergePr`, `armAutoFixOnNextPr` | não |
| Worktrees | `.claude/worktrees/`, `discardKeptWorktree` | não |
| Side chats | `startSideChat`, `startBtwChild` | não |
| Tarefas em background | `backgroundTasks`, `getTaskOutput`, `stopTask` | não |
| MCP por sessão com OAuth e resources | `mcpAuthenticate`, `mcpListResources` | parcial: stdio, só ferramentas |
| Plugins e marketplace | `LocalPlugins`, `CustomPlugins` | não |
| Skills | `claude.skills`, "Add skill" | parcial: pasta do usuário, sem UI de gestão |
| Rotinas agendadas | `CCDScheduledTasks` | não |
| SSH / WSL / nuvem | ~60 métodos SSH, `listWslDistros`, `teleportToCloud` | não |
| Preview de app | `FramebufferPreview`, "Preview tabs" | não (o "navegador" mostra capturas) |
| Split view / pop-out | `SessionPopouts`, `WindowLayout` | não |
| Confiança de pasta | `checkTrust`, `saveTrust` | parcial: raízes autorizadas |
| Computer Use com modo "ensinar" | `claude.internal.computerUse` (`CuTeach`, gravação) | parcial/quebrado |
| Chrome do usuário | `ChromeExtension`, `chrome-native-host.exe` | não (Playwright em navegador separado) |
| Cowork em VM | `cowork-svc.exe` (Go, VM Hyper-V via API HCS + hvsocket), `ClaudeVM`, `smol-bin.x64.vhdx` | não (aba Cowork usa o mesmo harness, sem VM). Alternativas de sandbox no Windows: VM via HCS (como o Claude) ou confinamento por ACL + integridade Low (como o deepseek-harness) |

## 9. O que reaproveitar dos repositórios

| Necessidade | Fonte (licença) | Forma |
|---|---|---|
| Catálogo de modelos, compatibilidade por modelo, erros/retry, cache de prompt, reparo de entrada de ferramenta, descoberta Ollama/LM Studio | opencode (MIT) | portar tabelas/dados para TS simples; não depender de Effect |
| Edição robusta (normalização, CRLF) | opencode (MIT) | portar a cascata de `edit.ts` |
| Hooks (eventos e protocolo) | openharness (MIT) + ideia de claw-code-local (sem licença) | implementar próprio; protocolo exit 0/2 + JSON |
| Permissões por padrão + caminhos sensíveis | openharness (MIT), opencode (MIT) | portar conceito |
| Compactação em camadas e reativa | openharness (MIT), opencode (MIT) | portar conceito |
| Tarefas em background | openharness (MIT) | portar conceito |
| Executores externos (Claude Code, Codex, OpenCode, ACP) | cdesktop (Apache-2.0), deepseek-harness (MIT) | reescrever em TS; manter aviso Apache se copiar arquivos TS |
| Terminal PTY, docking de painéis, navegador `<webview>` | deepseek-harness (MIT) | `ui-dockkit` e `subprocess-local` como base |
| Worktrees, diff com comentários, grade de sessões | cdesktop (Apache-2.0) | referência; componentes TS copiáveis com `NOTICE` |
| Computer Use persistente | open-computer-use (MIT) | usar o modo `mcp` existente |
| DPI e coordenadas por monitor | Mcp.ComputerUse (sem licença) | só a ideia; implementação própria com `screen.getAllDisplays()` do Electron |
| Investigação de apps pelo agente | REA (MIT) | MCP stdio, com filtro de ferramentas |

## 10. Plano priorizado

**P0 — consertar e validar (antes de qualquer superfície nova)**

1. Corrigir os defeitos 1–7 e 9 de §5, cada um com teste que falhe antes da
   correção.
2. Conectar um provedor real e rodar os testes A–J, registrando resultados em
   `docs/tests/`.
3. Decidir com o usuário o padrão de autonomia (defeito 8).

**P1 — robustez do harness multi-provedor**

4. Catálogo de modelos + tabela de compatibilidade + descoberta de modelos
   locais.
5. Classificação de erros, `retry-after`, timeouts de stream, compactação
   reativa e continuação por `length`.
6. Cache de prompt na Anthropic/OpenRouter.
7. Hooks configuráveis (PreToolUse, PostToolUse, UserPromptSubmit, Stop,
   SessionStart, PreCompact) e permissões por padrão com persistência.
8. Tarefas em background com leitura posterior de saída; subagentes
   assíncronos.

**P2 — arquitetura e superfícies centrais da aba Code**

9. Harness em processo próprio com protocolo de eventos (§4).
10. Terminal PTY real (node-pty + xterm).
11. Worktree opcional por sessão.
12. Diff com comentários por linha que voltam ao composer.
13. Executor externo: Claude Code via Agent SDK/stream-json; depois Codex e
    OpenCode.
14. REA como MCP opcional para o agente investigar apps.

**P3 — paridade ampliada**

15. Rewind/checkpoints, side chats, rotinas, plugins/marketplace, preview
    embutido, split view, SSH/WSL, ponte com o Chrome do usuário.

## 11. Decisões que dependem do usuário

1. **Qual provedor usar nos testes reais** (chave de nuvem ou subir LM
   Studio/Ollama local). Sem isso, A–J não podem ser executados.
2. **Padrão de autonomia** na primeira execução (hoje é "perguntar").
3. Se o Openclod deve **rodar o Claude Code CLI** como executor (usa a assinatura
   do usuário) além do harness próprio.

## 12. Correções aplicadas (2026-10-23, tarde)

Verificação: `npm run build` sem erros; `vitest` **105 testes passando** (64
anteriores + 41 novos em `tests/fixes.test.ts` e `tests/harness.test.ts`);
o app abriu com 0 erros de console e aplicou a migração de configurações.

| # | Defeito | Correção | Prova |
|---|---|---|---|
| 1 | Ações por elemento falhavam | `ComputerLayer` mantém um único `open-computer-use mcp` vivo; se o backend reiniciar, tira snapshot e repete uma vez | teste com backend falso; **teste ao vivo** no `open-computer-use` 1.3.0 real: depois de `get_app_state`, clicar num índice inexistente devolve `unknown element_index` (antes: "No app state") |
| 2 | Erros viravam sucesso | `isError` → `ok: false` em todas as ferramentas | `computerClickTool` com app inexistente → `ok: false` |
| 3 | Ativar janela / abrir app | `{window: {id}}`; travas `ALLOW_FOCUS_ACTIONS`/`ALLOW_APP_LAUNCH` ligadas só com o controle habilitado | backend falso confere o formato e a trava |
| 4 | Coordenadas erradas | origem e escala da última captura guardadas; `clickAt`/`drag` convertem; clique por coordenada da janela via `window` | `screenshotToScreen` com monitor à esquerda e escala 1600/3840 |
| 5 | `edit_file` com `$` | `applyEdit` sem `String.replace`; CRLF preservado; aspas tipográficas toleradas | 5 testes, incluindo gravação em disco de `$$` |
| 6 | Memória fora do prompt | fatos carregados a cada turno e após `memory_write` | prompt contém o fato salvo |
| 7 | Permissões sem argumentos | motor de regras na sintaxe do Claude Code (`Bash(npm test:*)`, `Edit(src/**)`, `Read(.env)`, `WebFetch(domain:…)`, `mcp__srv`), deny > ask > allow; "permitir sempre" grava regra por projeto; `.forja/settings.json` (e `.claude/` opcional) | 11 testes |
| 8 | Padrão "perguntar" | padrão `auto`; migração única de instalações no antigo padrão (backup em `settings.json.bak-2026-10-23`); arquivos de segredo pedem confirmação | teste de migração; `settings.json` real migrado para `auto`, versão 2 |
| 9 | Parâmetros fixos por modelo | `temperature` só quando configurada e nunca para o-series/gpt-5; `max_completion_tokens` na OpenAI; raciocínio guardado e reenviado dentro do loop de ferramentas para modelos "thinking" | testes de corpo da requisição |
| 10 | Código morto / rótulo | `RightPane.tsx` removido; aba "Terminal" → "Atividade" | typecheck |
| 11 | **Novo:** chaves salvas pela UI nunca funcionavam | o cofre criptografava o arquivo inteiro mas tentava descriptografar cada chave, e na reinicialização lia o arquivo cifrado como JSON. Agora: arquivo = `encrypt(JSON)`, chaves só em memória, leitura do formato antigo | teste salvar → reiniciar → ler |

Além dos defeitos, para aproximar o comportamento do Claude Code:

- **Hooks** no formato do Claude Code (`PreToolUse`, `PostToolUse`,
  `UserPromptSubmit`, `Stop`, `SubagentStop`, `SessionStart`, `PreCompact`,
  `Notification`), com exit 2 bloqueando e JSON (`permissionDecision`,
  `updatedInput`, `additionalContext`). 4 testes.
- **Loop**: compactação e nova tentativa ao estourar a janela de contexto;
  continuação automática quando a saída é cortada; última iteração sem
  ferramentas com resumo; reparo de argumentos (`"10"` → `10`); nova tentativa
  em falha transitória. 5 testes.
- **Provedores**: classificação de erro (contexto, cota, rate limit,
  sobrecarga, auth…), `Retry-After`/`retry-after-ms`/`x-should-retry`, 5
  tentativas com jitter, timeout de cabeçalho (5 min) e de stream ociosa
  (10 min), cache de prompt na Anthropic (sistema, ferramentas e cauda),
  `tool_choice: none`. 6 testes.
- **Processos em segundo plano**: `run_command` com `run_in_background`,
  `read_process_output` (saída nova desde a última leitura) e
  `list_processes`. 1 teste.
- **Computer Use**: `computer_secondary_action`, `computer_wait_for`, clique
  com botão direito, snapshot por janela com imagem.
- **Subagente** usa o mesmo modelo da sessão pai e herda regras e hooks.
- `delete_path` não pede confirmação duas vezes.

### O que **não** foi possível validar

- **Nenhum turno com modelo real.** Nesta máquina: sem chaves de API; as
  pastas de modelos do LM Studio só têm projetores de visão (os pesos foram
  apagados); o Ollama foi desinstalado e o único modelo restante
  (`qwen3.5:4b`, arquitetura `qwen35`) não é indexado pelo runtime do LM
  Studio; o FreeLLMAPI responde em `http://127.0.0.1:31415/v1`, mas exige a
  chave guardada nele, que não foi lida. Para rodar os testes A–J: em
  Configurações → Provedores, adicionar um provedor personalizado
  `http://127.0.0.1:31415/v1` e colar a chave do FreeLLMAPI (o cofre agora
  funciona), ou configurar uma chave de nuvem.
- Computer Use com clique real: só leitura foi exercitada no backend real.
- Continuam abertos: terminal PTY, worktrees, diff com comentários, harness em
  processo separado, executor externo (Claude Code/Codex), MCP por HTTP,
  catálogo de modelos e descoberta automática de modelos locais.


## 13. Rodada de interface e ferramentas (2026-10-23, noite)

Verificação: `npx tsc` limpo nos dois projetos; `npx vitest run` →
**14 arquivos, 475 testes passando** (105 no início da rodada anterior);
`electron-vite build` sem erros; roteiro `scripts/ui-panes.cjs` no app real com
0 erros de console. Detalhes e evidências por tela em
[`UI_COMPARISON.md`](UI_COMPARISON.md); comparação com os repositórios em
[`REPOSITORY_FEATURE_AUDIT.md`](REPOSITORY_FEATURE_AUDIT.md).

| Área | O que passou a existir | Prova |
|---|---|---|
| Interface | terminal PTY, navegador `<webview>` com detecção de servidor de dev, alterações via Git, editor CodeMirror com salvamento, painel redimensionável/maximizável/esquerda-direita, tarefas em segundo plano, "manter computador ativo", páginas Projetos / Agendados / Personalização, troca rápida de permissão | roteiro de UI no app real (resultados em `UI_COMPARISON.md`) |
| Agendador | tarefas diárias/semanais/etc., execução perdida roda uma vez, sem sobreposição | 85 testes + uma execução real (provedor Scripted) |
| Git | `status`/`diff` por arquivo, worktrees (sem UI) | 55 testes em repositórios temporários |
| Segurança | credenciais do usuário (`~/.ssh`, `.aws`, …) bloqueadas em qualquer modo, inclusive contra "permitir" | 130 testes em `core-gaps.test.ts` (20 mutações deliberadas foram detectadas) |
| Harness | saída grande vai para arquivo; resumo de compactação estruturado; hooks `http`, `SessionEnd` e `PostCompact` | idem |
| Provedores | descoberta de modelos; **esforço de raciocínio**: `thinking` adaptativo + `output_config.effort` (Claude 4.6+/5.x), `budget_tokens` (Claude 4.5 e anteriores), `reasoning_effort` (o-series/gpt-5); blocos de raciocínio do Claude capturados com assinatura e reenviados na ordem original; recuperação documentada quando a API rejeita uma assinatura | 16 + 3 testes |
| Agentes e MCP | ferramenta `external_agent` (Claude Code, Codex); filtros/aprovações/timeout por servidor MCP; preset do REA | 35 + 30 testes; handshake real com o REA (185 ferramentas) |
| Correção | **ferramentas MCP nunca chegavam ao modelo** | teste no `runner` |

Detalhes técnicos que valem registro:

- Sobre `temperature` na Anthropic: o Openclod envia `anthropic-version:
  2023-06-01`; nessa versão o parâmetro ainda é aceito nos modelos antigos,
  mas é rejeitado no Opus 4.7+, Fable/Mythos, Sonnet 5.x e Haiku 5.x e sempre
  que há thinking. O provedor agora omite o parâmetro nesses casos. Migrar o
  cabeçalho para `2026-10-21` exigiria remover `temperature`/`top_p`/`top_k`
  de vez — não foi feito.
- Contas Anthropic criadas a partir de 2026-08-31 têm a verificação de
  "thinking preservado" ativa: editar turnos antigos invalida os blocos
  seguintes (HTTP 400). Por isso a compactação descarta os blocos dos turnos
  que mantém, e o provedor reenvia uma vez sem raciocínio se a API rejeitar a
  assinatura. **Isto não foi testado contra a API real.**

### O que continua sem validação

- **Nenhum turno com modelo real.** Tudo acima do modelo foi exercitado com
  servidores falsos, CLIs falsos e o provedor Scripted.
- `external_agent` com os CLIs reais, REA dentro de um turno e o instalador
  (`npm run dist`, com `asarUnpack` para o PTY) não foram executados.
- O seletor de esforço com um modelo que o suporte, "Detectar modelos" e o
  botão do preset do REA não foram clicados na interface.
