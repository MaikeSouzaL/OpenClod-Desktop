# Estudos Computer Use — resumo e prioridades

> Três clones analisados estaticamente em
> `repositorios/_research/computer-use/` — o escopo desta rodada foi
> `CarlosShao--win-computer-use`, `dutuanan96--desktop-use` e
> `asweigart--pyautogui`; outros estudos da mesma pasta não entram aqui.
> Método: leitura de código, sem instalar dependências e sem rodar os testes dos
> clones. Cada estudo individual tem 13 seções e cita caminho+linha. Data da
> análise: 2026-10-26.
>
> Referências do nosso lado: `src/core/computer/layer.ts`,
> `src/core/tools/computer.ts` e a seção Computer Use de
> `docs/research/GAP_ANALYSIS.md:151-167`.

## Veredito por repositório

| Repositório | O que é de fato | Valor para o Openclod | Risco |
|---|---|---|---|
| `CarlosShao--win-computer-use` | CLI + FastAPI (não é MCP) com pyautogui/UIA/OCR e screenshot semântico | melhor fonte para **ranquear a árvore de acessibilidade** e para **screenshot com alvos numerados** | sem nenhum teste; servidor quebrado |
| `dutuanan96--desktop-use` | bridge HTTP/WS para WSL; 26 ações; WebSocket não funciona | serve como **máquina de estados negativa** e pela ideia de **batch** | `0.0.0.0` sem auth; injeção em PowerShell |
| `asweigart--pyautogui` | biblioteca de input madura; sem agente, UIA ou servidor | melhor fonte para **mapa de teclas**, **tween de ponteiro** e **hold** | APIs legadas; assume um monitor |

Nenhum dos três é um harness de agente: não há loop, contexto, streaming de
modelo ou política de ferramentas. O que se aproveita é a camada **input +
percepção**, que é exatamente onde o nosso `ComputerLayer` ainda tem lacunas.

## 12 candidatos priorizados

Score 0–25 = encaixe no harness (0–10) + qualidade/testes (0–5) + robustez de
bordas/segurança (0–5) + portabilidade/licença (0–5).

| # | Candidato | Origem (arquivo:linha) | Score | Tipo | Destino proposto |
|---|---|---|---:|---|---|
| 1 | Mapa de teclas (nomes + VK: numpad, mídia, browser, OEM, PrintScreen) | `asweigart--pyautogui/pyautogui/_pyautogui_win.py:113-247` | 22 | porta (tabela) | `src/core/computer/keymap.ts` |
| 2 | Caminho de ponteiro com `duration` + `tween` e passo mínimo | `asweigart--pyautogui/pyautogui/__init__.py:1417-1514`, `:605-628` | 19 | reimplementação | `src/core/computer/pointer-path.ts` |
| 3 | Ranking + NMS + dedup de clusters da árvore de acessibilidade | `CarlosShao--win-computer-use/win_computer_use/markers.py:146-191`, `:497-595` | 19 | porta (algoritmo) | `src/core/computer/snapshot-rank.ts` |
| 4 | Digitação por clipboard para texto não-ASCII, com fallback em 3 níveis | `CarlosShao--win-computer-use/win_computer_use/input_control.py:111-136` | 19 | porta (conceito) | `src/core/computer/layer.ts` (`typeText`) |
| 5 | `hold()`: down/up em contexto, release garantido em `finally` | `asweigart--pyautogui/pyautogui/__init__.py:1621-1655` | 18 | porta (conceito) | `src/core/computer/layer.ts` |
| 6 | Ring de screenshots antes/depois por ação | `asweigart--pyautogui/pyautogui/__init__.py:706-749` | 17 | reimplementação | `src/core/computer/audit.ts` |
| 7 | Screenshot semântico com alvos numerados e lista de coordenadas | `CarlosShao--win-computer-use/win_computer_use/markers.py:602-728`, `:735-929` | 17 | porta (pipeline) | `src/core/computer/markers.ts` |
| 8 | Busca de elemento por critérios UIA (`auto_id`/type/name) como fallback do índice | `CarlosShao--win-computer-use/win_computer_use/ui_find.py:126-222` | 17 | porta (conceito) | `src/core/computer/layer.ts` (`findElement`) |
| 9 | `computer_batch`: lote sequencial, para no primeiro erro, resultado por passo | `dutuanan96--desktop-use/desktop_use/server.py:1178-1186`, `:1238-1253` | 16 | porta (conceito) | `src/core/tools/computer.ts` |
| 10 | Catálogo único `nome → handler/risco/schema` | `dutuanan96--desktop-use/desktop_use/server.py:950-1196` | 16 | reimplementação | `src/core/computer/catalog.ts` |
| 11 | Kill switch cross-process (arquivo/flag) | `CarlosShao--win-computer-use/win_computer_use/safety.py:20-88` | 16 | porta (conceito) | `src/core/computer/kill-switch.ts` |
| 12 | Failsafe de canto + pausa global entre ações | `asweigart--pyautogui/pyautogui/__init__.py:572-573`, `:1732-1736` | 15 | reimplementação | `src/core/computer/input-guard.ts` |

### Não priorizados (mas estudados)

| Item | Origem | Score | Por que ficou fora do top 12 |
|---|---|---:|---|
| Cascata de engines de OCR com escolha por conteúdo (CJK) | `CarlosShao--win-computer-use/win_computer_use/winocr.py:140-228` | 14 | nosso `ocr.ts` já usa `Windows.Media.Ocr`; falta só o re-ranqueamento |
| Template matching multi-scale | `CarlosShao--win-computer-use/win_computer_use/image_match.py:51-161` | 13 | o modelo de visão cobre melhor; útil só para canvas |
| OCR aquecido em processo persistente | `dutuanan96--desktop-use/desktop_use/server.py:120-139` | 13 | depende de reescrever `ocrImage` para um processo longo |
| Anel de frames para preview ao vivo | `dutuanan96--desktop-use/desktop_use/server.py:802-864` | 12 | é feature de UI, não de harness; custo de CPU a 5 fps |
| `useImageNotFoundException` (contrato explícito) | `asweigart--pyautogui/pyautogui/__init__.py:267-281` | 9 | padrão de API, não código |
| Cliente fino `{success,data,error}` | `dutuanan96--desktop-use/desktop_use/client.py:118-154` | 9 | já temos `ToolResult` |
| Envelope CLI `{ok,action,data\|error}` | `CarlosShao--win-computer-use/win_computer_use/cli.py:33-56` | 8 | já temos `ToolResult` |
| Mapeamento de caminho Windows→WSL | `dutuanan96--desktop-use/desktop_use/client.py:64-80` | 3 | não se aplica a um app Windows nativo |

## O que NÃO portar

| Item | Repositório | Motivo |
|---|---|---|
| Servidor FastAPI (`server.py`) | win-computer-use | sem auth, imports que não sobem na forma empacotada, `_ok()` com aridade errada em `/lock` e `/record/*` |
| Árvore `scripts/` duplicada | win-computer-use | cópia morta da mesma implementação, com imports absolutos |
| `input_lock.py` (hooks de baixo nível) | win-computer-use | bloqueia teclado/mouse do usuário; inaceitável no app |
| Recorder/replay de macros | win-computer-use | executa sequência arbitrária sem política nem confirmação |
| `count_image` (sem NMS) | win-computer-use | conta cada pixel acima do threshold; o número não é "quantos botões" |
| Servidor HTTP + WebSocket | desktop-use | `0.0.0.0` por padrão, sem auth; handler WS com API errada (`server.py:1310-1366`) |
| `post_click/post_type/post_hotkey` | desktop-use | já temos `click_method: 'app_post'` (`layer.ts:22`, `:367-375`); o deles cai no pyautogui quando não acha a janela (`server.py:1073-1078`) |
| Virtual display (`get_all_monitors` etc.) | desktop-use | código morto; `rect` fixo em `[0,0,w,h]` para todo monitor (`server.py:891`, `:902`) |
| `run_script` | desktop-use | contrato de execução arbitrária; nem o servidor implementa |
| PowerShell para clipboard | desktop-use | Electron tem `clipboard` nativo; o caminho `post_type` sofre injeção (`server.py:668-669`) |
| Biblioteca pyautogui inteira | pyautogui | Python/ctypes; nosso backend é UIA + SendInput via `open-computer-use` |
| `mouse_event`/`keybd_event` | pyautogui | APIs legadas; `SendInput` é o caminho correto |
| `_size()`/`onScreen`/`FAILSAFE_POINTS` | pyautogui | assumem monitor primário; nosso `CaptureInfo` já tem origem/escala do desktop virtual (`layer.ts:36-44`) |
| `typewrite` para texto real | pyautogui | `VkKeyScanA` cobre 32–127 e descarta o resto em silêncio (`_pyautogui_win.py:246-247`, `:264-265`) |
| `run()` (DSL de string) | pyautogui | segunda linguagem; o modelo já emite tool calls |
| Overlay/NotifyBar Tkinter | win-computer-use | já temos `ComputerActivityTracker` + borda laranja (`src/core/computer/activity.ts:11-60`) |

## Lacunas do nosso Computer Use

O `GAP_ANALYSIS.md:151-167` foi escrito antes de algumas correções; dois itens já
não valem: `computer_wait_for` existe (`computer.ts:712-753`) e `list_apps`
existe (`computer.ts:75`). O que continua aberto, comparando com os três clones:

1. **Sem screenshot semântico.** `computer_screenshot` devolve só a imagem
   (`computer.ts:187-211`) e o snapshot devolve texto (com imagem opcional da
   janela, `layer.ts:307-351`); não há como o modelo dizer "clique no alvo 7" a
   partir da imagem. É a lacuna que os `markers.py` resolvem — com o cuidado de
   amarrar o rótulo ao `snapshot_id`.
2. **Árvore sem ranking.** `limitSnapshotText` só corta por caractere
   (`layer.ts:24-34`); uma janela com 300 nós vira 300 linhas truncadas em vez de
   50 alvos ordenados. `markers.py:146-191` e `:497-595` são a referência.
3. **Digitação sem fallback para não-ASCII.** `typeText` repassa o texto cru
   (`layer.ts:609-611`); não há caminho de clipboard como
   `input_control.py:111-136`. Se o backend perder CJK/emoji, o agente não sabe.
4. **Captura só do desktop virtual inteiro.** Não há região nem monitor
   (`layer.ts:643-701`; `GAP_ANALYSIS.md:156`). Os dois clones também erram
   nisso: win-computer-use grava a imagem sem origem (`screen.py:57-113`) e
   desktop-use usa `monitors[1]` (`server.py:281`), então servem de aviso.
5. **DPI não explícito na captura.** O script PowerShell de `captureScreen`
   (`layer.ts:649-665`) não chama `SetProcessDpiAwareness`; o pyautogui chama
   (`_pyautogui_win.py:15-19`) e o win-computer-use tenta no import
   (`platform_util.py:23-41`). Origem e escala saem do mesmo `VirtualScreen`
   (`layer.ts:683-690`), então uma suposição errada de DPI contamina as duas.
   Não verificado em execução — é hipótese estática.
6. **OCR não vira coordenada de tela.** `ocr.ts` devolve caixas em pixels da
   imagem (`src/core/media/ocr.ts:5-16`, `:38`); nenhum chamador converte para
   tela usando `CaptureInfo`. Falta o `screenshotToScreen` para palavras.
7. **Sem lote.** Cada ação é um round-trip de tool; não há
   `computer_batch` como `server.py:1178-1186`. O `SKILL.md:23-33` do
   win-computer-use mostra o custo: 3–5 chamadas por tarefa é a meta.
8. **Auditoria sem antes/depois.** `events.jsonl` registra a ação, não o estado
   (`GAP_ANALYSIS.md:167`). O ring do pyautogui (`__init__.py:706-749`) é a
   referência mais barata.
9. **Sem kill switch independente do turno.** O abort atual é `AbortSignal` do
   turno; não há um flag persistido (arquivo/atalho) que qualquer processo ligue
   e que toda ação respeite, como `safety.py:64-88`.
10. **Sem `hold` de tecla.** Só existe chord fechado (`press_key`,
    `layer.ts:451-456`); seleção com Shift e drag de tecla exige down/up
    separados como `__init__.py:1621-1655`.

### O que já estamos melhores (não regredir)

| Capacidade | Onde | Por que os clones não têm |
|---|---|---|
| Snapshot com `snapshot_id`/`generation` e `element_stale` | `layer.ts:315-393` | nenhum dos três valida a idade da referência |
| Verificação pós-ação com `state_changed` | `layer.ts:263-291` | win-computer-use só executa e devolve `ok` |
| Conversão screenshot→tela com origem e escala | `layer.ts:140-146`, `:543-555` | pyautogui calcula tudo pelo primário; desktop-use não compensa região |
| Um processo `open-computer-use mcp` persistente | `layer.ts:226-247` | win-computer-use sobe Python por comando; desktop-use é HTTP |
| Permissões por ferramenta e modo | `src/core/security/permissions.ts:185-249` | nenhum clone tem política |

## Ordem de implementação sugerida

1. **`keymap.ts`** (score 22): tabela + normalizador, sem tocar em backend.
   Impacto imediato em `press_key` (hoje só 24 aliases, `layer.ts:104-137`),
   risco quase zero.
2. **`pointer-path.ts` + `hold`** (19 + 18): arrasto/hover que funcionam em apps
   com limiar de movimento; usar nos tools `computer_drag`/`computer_mouse_move`.
3. **`snapshot-rank.ts` + `markers`** (19 + 17): o maior ganho de qualidade por
   token; depende de amarrar marcador a `snapshot_id`.
4. **`typeText` com clipboard + `computer_batch`** (19 + 16): fecha Unicode e
   reduz round-trips.
5. **`audit.ts` + `kill-switch.ts`** (17 + 16): confiança operacional; não muda
   a capacidade, muda a capacidade de auditar e parar.
6. **OCR→tela e captura por região** (14): só depois de estabilizar a captura e
   o DPI.

## Licenças e reuso

MIT nos dois primeiros, BSD-3-Clause no pyautogui (`LICENSE.txt:1-20`). Ideias e
tabelas de fatos (nomes de tecla, VK codes) não são obstáculo. Se algum trecho de
código for copiado literalmente, o BSD-3 exige manter o copyright e a lista de
condições; o MIT exige o aviso. Registrar a origem no cabeçalho do arquivo novo,
como já é praxe nos outros estudos.

## Arquivos produzidos

- `docs/research/estudos/computer-use/CarlosShao--win-computer-use.md`
- `docs/research/estudos/computer-use/dutuanan96--desktop-use.md`
- `docs/research/estudos/computer-use/asweigart--pyautogui.md`
- `docs/research/estudos/computer-use/_RESUMO.md`
