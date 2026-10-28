# win-computer-use

| Campo | Valor |
|---|---|
| Repositório | https://github.com/CarlosShao/win-computer-use |
| Clone local | `repositorios/_research/computer-use/CarlosShao--win-computer-use` |
| Commit | `e4b15d56dfc5b01ca19fac79116b90c71f0979f7` (2026-06-28) |
| Licença | MIT (`LICENSE:1-3`) |
| Categoria | computer-use (toolkit de automação de desktop) |
| Stack | Python ≥ 3.10 (`pyproject.toml:14`); pyautogui, pywinauto, `uiautomation`, mss, OpenCV, Pillow, pytesseract (`pyproject.toml:15-23`); FastAPI/uvicorn e RapidOCR/tesserocr como extras (`:25-33`); setuptools |
| Tamanho | 51 arquivos; 34 `.py`; ~9.524 linhas Python (inclui a cópia `scripts/`); 2 entrypoints (`pyproject.toml:35-37`) |

## 1. O que é (verificado no código)

É um **toolkit Windows-only** de automação de desktop para agentes: screenshot,
mouse/teclado, janelas, UI Automation, template matching OpenCV, OCR, gravação e
replay de macros, trava de input e um "screenshot semântico" com marcadores
numerados (`win_computer_use/markers.py:1-10`). Cada subcomando imprime **um
único JSON** em stdout e sai com 0/1 (`cli.py:33-56`).

O entrypoint real é `win_computer_use/cli.py:844-863` (console script
`win-computer-use`, `pyproject.toml:35-37`) e o servidor é
`win_computer_use/server.py:612-619` (`win-computer-use-server`).
O README e o docstring do servidor dizem "MCP-compatible"
(`server.py:1-21`), mas **não há MCP**: nenhum `initialize`, nenhum JSON-RPC,
nenhum `tools/list`; são 44 rotas REST com corpo JSON.

A árvore `scripts/` é a versão **pré-pacote** dos mesmos módulos, com imports
absolutos (`scripts/ocr.py:26` importa `screen`; `scripts/input_control.py:20`
importa `safety`); `scripts/cli.py:1-21` é só um shim para o pacote. A cópia
empacotada é a canônica — e é ela que tem os defeitos de import da §8. A versão
do `pyproject.toml:7` é `1.1.0`, mas `__init__.py:34` diz `0.1.0`.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pip install -e .` | `pyproject.toml:35-37` | instala e cria `win-computer-use` e `win-computer-use-server` |
| `win-computer-use screenshot --output x.png [--base64]` | `cli.py:64-94`, `573-590` | captura desktop virtual, grava PNG e devolve `{path,width,height,bytes}` |
| `win-computer-use screenshot --with-markers [--all-windows]` | `cli.py:72-82`, `markers.py:735-929` | screenshot com caixas numeradas + lista de elementos |
| `win-computer-use click X Y` / `move` / `drag` / `scroll` | `cli.py:112-135`, `598-636` | input global via pyautogui |
| `win-computer-use type "texto"` / `hotkey ctrl s` / `key-press enter` | `cli.py:141-158`, `638-656` | texto (ASCII rápido, resto por clipboard) e chords |
| `win-computer-use list-windows / activate-window / minimize` | `cli.py:206-241` | enumeração e comandos `WM_SYSCOMMAND` |
| `win-computer-use find-element / click-element / set-text / wait-element` | `cli.py:257-292` | UI Automation por `auto_id`/`control_type`/`name` |
| `win-computer-use find-image / click-image / wait-image / count-image` | `cli.py:307-356` | OpenCV `matchTemplate`, com `--multi-scale` |
| `win-computer-use ocr / ocr-words [--backend]` | `cli.py:438-459`, `785-799` | OCR com RapidOCR/Tesseract/tesserocr |
| `win-computer-use smart-click ...` | `cli.py:361-432` | cascata UIA → OCR → template |
| `win-computer-use emergency-stop / clear-stop / failsafe on\|off` | `cli.py:465-481` | trava persistida em arquivo JSON |
| `win-computer-use rec-start / rec-stop / rec-play` | `cli.py:484-525` | hooks `WH_KEYBOARD_LL`/`WH_MOUSE_LL` e replay |
| `win-computer-use lock / unlock` | `cli.py:528-546` | bloqueia mouse/teclado do usuário por N segundos |
| `win-computer-use-server --host 127.0.0.1 --port 8000` | `server.py:612-619` | sobe a API REST (44 rotas) — falha com `ImportError` na forma empacotada (§8) |

Superfície de UX: 42 subcomandos (`cli.py:570-841`), duas flags globais
(`--lock-input`, `--lock-timeout`, `cli.py:559-569`) e um `NotifyBar` Tkinter
que **sempre** aparece durante a execução (`cli.py:848-863`,
`notify.py:29-60`). O servidor expõe 44 rotas (screenshot, pixel, mouse,
teclado, janelas, UI, imagem, OCR, `smart-click`, safety, lock e recorder —
`server.py:90-604`).

## 3. Arquitetura e fluxo

```
win-computer-use <cmd>                     (argparse, cli.py:554-841)
  → input_control / window_mgmt / ui_find / image_match / ocr / markers
  → pyautogui (mouse_event/keybd_event) | pywinauto+uiautomation | mss | OpenCV | OCR
  → stdout: {"ok": true, "action": "<cmd>", "data": ...}   (cli.py:33-43)

win-computer-use-server                     (FastAPI, server.py:81-604)
  → _wrap() → mesma camada de módulos         (server.py:66-74)
```

- Entry point CLI: `cli.py:844-863`; parser: `cli.py:554-841`.
- Entry point servidor: `server.py:612-619`; app: `server.py:81-85`.
- Execução de ferramenta: funções de módulo, ex. `input_control.py:45-64`,
  `ui_find.py:225-280`, `window_mgmt.py:147-185`.
- Streaming: **não há**. Uma chamada = um JSON no fim; OCR e screenshot passam
  por arquivo em disco (`screen.py:88-102`, `ocr.py:180`).
- Persistência: PNGs em `screenshots/` (`screen.py:35-40`), estado de safety em
  `logs/safety_state.json` (`safety.py:20`), macros em JSON
  (`recorder.py:6-17`, `272-315`).

O servidor reimplementa o dispatch em vez de chamar o CLI: duplica
`_ok/_err/_wrap` (`server.py:55-74` vs `cli.py:33-56`) e repete cada endpoint.
Não há fila, sessão ou estado por cliente.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Screenshot de monitor/região | `screen.py:57-113` | `mss` grava PNG e devolve dimensões; `monitor_index` 0 = desktop virtual | baixo |
| Cor de pixel | `screen.py:116-122` | `grab` 1×1 e `pixel(0,0)` | baixo |
| Mover/clicar/duplo/drag/scroll | `input_control.py:38-103` | pyautogui com `FAILSAFE=True`, `PAUSE=0.02` (`:23-24`) | alto |
| Digitar (ASCII ou clipboard) | `input_control.py:111-136` | `typewrite` para ASCII curto; senão `pyperclip` + `ctrl+v` | alto |
| Hotkey / key-down / key-up | `input_control.py:139-163` | `pyautogui.hotkey/press/keyDown/keyUp` | alto |
| Espera interrompível | `input_control.py:166-172` | dorme em fatias de 50 ms checando o stop | baixo |
| Listar/find janelas | `window_mgmt.py:43-144` | `pygetwindow`, filtro por substring/regex, dedup por handle+título | baixo |
| Ativar janela | `window_mgmt.py:147-185` | `ShowWindow`+`SetWindowPos`+`SetForegroundWindow` | médio |
| Min/max/restore/close | `window_mgmt.py:188-217` | `SendMessageW(WM_SYSCOMMAND)` | alto |
| Find/click/set-text elemento | `ui_find.py:126-313` | pywinauto UIA; fallback `descendants()` | alto |
| Texto de elemento | `ui_find.py:316-364` | `get_value`/`texts()`/`window_text()` | baixo |
| Esperar elemento | `ui_find.py:367-384` | polling de `find_element` | baixo |
| Template matching (com contagem) | `image_match.py:51-161`, `:208-222` | `TM_CCOEFF_NORMED`, multi-scale `[1.0,1.25,1.5]`; `count_image` não aplica NMS | médio |
| OCR (texto/words) | `ocr.py:165-263` | RapidOCR → Tesseract → tesserocr; caixas com offset da região somado | médio |
| OCR nativo Windows | `winocr.py:140-228` | `Windows.Media.Ocr`, recorte e re-run para CJK | médio |
| Screenshot semântico | `markers.py:735-929` | UIA → filtros → NMS → clusters → desenho | médio |
| Smart click | `cli.py:361-432` | UIA → OCR → imagem | alto |
| Emergency stop / failsafe | `safety.py:64-88` | flag em JSON + `pyautogui.FAILSAFE` | baixo |
| Trava de input | `input_lock.py:314-377` | hooks de baixo nível + overlay | alto |
| Recorder/replay | `recorder.py:255-393` | grava eventos e reproduz com pyautogui | alto |

## 5. Loop do agente, contexto e streaming

Não existe loop de agente neste repositório: quem decide a sequência é o agente
externo que chama o CLI. O que existe é uma **política de orçamento de chamadas**
na skill: "one screenshot → plan ALL clicks → execute in batch", 3–5 chamadas
(`SKILL.md:23-33`) e proibição de screenshot no meio da tarefa
(`SKILL.md:33`).

O único encadeamento interno é o `smart-click` (`cli.py:361-432`): UIA, depois
OCR, depois template, engolindo exceções em cada etapa (`:391-392`,
`:414-415`); se as três falharem, devolve `RuntimeError` (`:430`). Não há retry
com backoff nem confirmação de que o clique mudou o estado.

Cancelamento: só o emergency stop, checado no começo de cada primitiva
(`input_control.py:40`, `53`, `84`, `97`, `118`, `141`) e dentro de `wait`
(`:166-172`). Uma chamada longa de `pyautogui.dragTo` (`:86-91`) não é
interrompível; `smart-click` também não checa o stop entre etapas.

Contexto: o agente recebe JSON, não uma árvore de acessibilidade. Em
`--with-markers`, recebe a lista `elements` com `id`, `text`, `rect` e
`control` (`markers.py:914-923`) — é o mais próximo de "contexto visual
estruturado" que o projeto oferece.

## 6. Sessões, estado e persistência

Não há sessões, retomada, fork ou checkpoint. O estado durável é:

| Estado | Onde | Observação |
|---|---|---|
| Stop/failsafe | `logs/safety_state.json` (`safety.py:20-44`) | compartilhado entre processos; `_write_state` não é atômico (sem `tmp`+rename) |
| Screenshots | `COMPUTER_USE_SCREENSHOT_DIR` (`screen.py:34-40`) | nome `shot-AAAAMMDD-HHMMSS-mmm.png` (`:86-87`) |
| Macros | JSON com `"version": 1` (`recorder.py:6-17`, `:272-315`) | sem migração nem validação de esquema; não há log estruturado de ações |

O recorder é o único formato versionado (`recorder.py:7`); não há teste de
compatibilidade entre versões.

## 7. Configuração e extensibilidade

Não há arquivo de configuração. Tudo vem de env var ou argumento:

| Chave | Onde | Efeito |
|---|---|---|
| `COMPUTER_USE_SCREENSHOT_DIR` | `screen.py:34-40` | diretório dos PNGs |
| `COMPUTER_USE_SAFETY_FILE` | `safety.py:23-26` | caminho do JSON de stop |
| `COMPUTER_USE_MATCH_THRESHOLD` | `image_match.py:28` | threshold padrão do template |
| `TESSDATA_PREFIX` / `--tesseract` | `ocr.py:15-17`, `:106-112` | binário/dados do Tesseract |

Extensibilidade: o pacote é distribuído como **skill de agente**
(`SKILL.md:1-5`, com `agent_created: true`), não como plugin. Não há hooks,
MCP, registro de ferramentas nem API de extensão. Os extras `server` e `ocr`
(`pyproject.toml:25-33`) são a única modularidade.

## 8. Permissões, sandbox e erros

**Não há modelo de permissão.** Qualquer subcomando executa direto; não há
allow-list de apps, confirmação humana, escopo de janela ou bloqueio de teclas
perigosas. O README promete "坐标越界保护" (proteção de coordenada fora da tela,
`README.md:238`), mas `move_to`/`click` passam o valor direto ao pyautogui
(`input_control.py:38-64`) — **não encontrado** nenhum `if` de bounds.

O que existe de proteção:

1. `emergency_stop` persistido em arquivo, checado no início das primitivas
   (`safety.py:64-88`);
2. `pyautogui.FAILSAFE = True` (`input_control.py:24`), que aborta quando o
   cursor vai ao canto — mas os cantos são calculados uma única vez a partir do
   monitor primário
   (`asweigart--pyautogui/pyautogui/__init__.py:2170-2171`, ver o estudo do
   pyautogui);
3. `input_lock` com hooks `WH_KEYBOARD_LL`/`WH_MOUSE_LL`, timeout de 30 s e
   saída por ESC×3 em até 2 s (`input_lock.py:47-50`, `:112-138`,
   `:314-377`). O CLI anota "needs admin" (`cli.py:560-563`); não verifiquei a
   exigência. Se o hook falhar, sobra só o overlay (`:157-166`) e o usuário fica
   sem teclado/mouse até o timeout.

Erros: `_wrap` devolve `{ok:false, error, traceback}` com o traceback completo
(`cli.py:46-56`); o servidor faz o mesmo (`server.py:66-74`). Isso vaza caminho
de instalação e nomes internos para o agente.

Defeitos concretos do servidor:

- `_ok(data=None)` recebe **dois** argumentos em `/lock`, `/unlock`,
  `/lock-status` e nos quatro `/record/*` (`server.py:55-56` vs `:540`, `:543`,
  `:553`, `:559`, `:573-597`) → `TypeError` em runtime.
- Imports quebrados: `server.py:42-48` importa `image_match`, `input_control`,
  `ocr`, `safety`, `screen`, `ui_find` e `window_mgmt` como módulos
  **top-level**, mas todos esses arquivos usam imports relativos
  (`screen.py:31`, `input_control.py:20`, `ocr.py:26`, `markers.py:36`, `:39`,
  `:866`). Como `server.py:38-40` põe o diretório do pacote no `sys.path`, o
  import carrega o arquivo como top-level e o `from . import` falha com "no
  known parent package" — o servidor não sobe na forma empacotada.
- `/screenshot?with_markers=true` faz `from markers import ...`
  (`server.py:105-109`), herdando o mesmo problema.
- Sem autenticação, CORS ou verificação de origem; `--host` permite `0.0.0.0`
  (`server.py:612-616`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Nenhuma automatizada | — | **não encontrado** diretório `tests/`, `pytest.ini` ou CI |
| Plano manual Lv1–Lv10 | `TEST_PLAN.md:1-45` | roteiro de execução manual por nível |
| Notas/roadmap | `NOTES.md:1-124`, `ROADMAP.md:1-45` | decisões e fases; não são testes |

O `README.md:242-246` fala em "55+ casos" — são casos **descritos** no plano,
não código. Não há teste de DPI, multi-monitor, UIA em Electron, nem de
recuperação de erro. Para um toolkit que move o mouse do usuário, isso é o
maior risco do repositório.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Ranking + NMS + dedup de clusters da árvore de acessibilidade | `markers.py:146-191`, `:497-595` | reduz 300+ nós a ≤50 alvos ordenados por valor, sem perder o "existe mais" | MIT | `src/core/computer/snapshot-rank.ts` | 19 |
| Digitação por clipboard para texto não-ASCII | `input_control.py:111-136` | resolve CJK/emoji onde `typewrite` perde caractere; fallback em 3 níveis | MIT | `src/core/computer/layer.ts` (`typeText`) | 19 |
| Screenshot semântico com alvos numerados | `markers.py:602-728`, `:735-929` | dá ao modelo um id estável por alvo visual quando a UIA não expõe nada | MIT | `src/core/computer/markers.ts` | 17 |
| Busca de elemento por critérios UIA (auto_id/type/name) | `ui_find.py:126-222` | alternativa quando o índice do snapshot falha ou o app reflui | MIT | `src/core/computer/layer.ts` (`findElement`) | 17 |
| Kill switch cross-process | `safety.py:20-88` | um arquivo/flag que qualquer processo (ou atalho) liga e toda ação respeita | MIT | `src/core/computer/kill-switch.ts` | 16 |
| Cascata de engines de OCR com escolha por conteúdo | `winocr.py:140-228`, `ocr.py:165-201` | usa OCR nativo rápido e re-roda em CJK; mede confiança | MIT | `src/core/media/ocr.ts` | 14 |
| Template matching multi-scale | `image_match.py:51-161` | cobre 100/125/150% de DPI sem depender de UIA | MIT | `src/core/computer/template.ts` | 13 |
| Envelope `{ok, action, data\|error}` | `cli.py:33-56` | contrato simples e estável para CLI | MIT | — (já temos `ToolResult`) | 8 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Servidor FastAPI (`server.py`) | sem auth, endpoints quebrados (`_ok`), imports que não sobem, duplica o CLI |
| Árvore `scripts/` | cópia morta da mesma implementação, com imports absolutos; fonte de confusão |
| `input_lock.py` | bloqueia teclado/mouse do usuário; inaceitável em um app de desktop; exige admin |
| Recorder/replay (`recorder.py`) | executa macros arbitrárias sem política, confirmação ou assinatura |
| pywinauto/uiautomation/pyautogui | stack Python incompatível; nosso backend já é UIA + SendInput via `open-computer-use` |
| `count_image` (`image_match.py:208-222`) | conta cada pixel acima do threshold; o número não é "quantos botões" |
| Overlay/NotifyBar Tkinter | já temos `ComputerActivityTracker` + borda laranja (`src/core/computer/activity.ts:11-60`), melhor integrado |

## 12. Modelo de exemplo para o nosso harness

1. **`SnapshotRanker`** (novo `src/core/computer/snapshot-rank.ts`): recebe a
   árvore textual que `ComputerLayer.snapshot` já devolve
   (`src/core/computer/layer.ts:307-351`) e produz três listas — `primary`
   (importância ≥ limiar), `clusters` (grupos de itens irmãos) e `dropped`.
   Regras do `markers.py:146-191` e `:553-595`: tipo → peso, texto aumenta o
   peso, tamanho filtra, grupo grande mantém 3 + o último.
2. **`SemanticShot`** (novo `computer_screenshot` com `markers: true`): usa a
   captura nativa (`layer.ts:643-701`) e o snapshot da **mesma** geração
   (`layer.ts:315-348`); projeta cada `rect` de tela para o espaço da imagem
   (`layer.ts:140-146`) e desenha os rótulos. O rótulo só vale para aquele
   `snapshot_id`; ref de outro snapshot devolve `element_stale`
   (`layer.ts:379-393`).
3. **`typeText` com fallback**: tenta `type_text` do backend; se o texto tiver
   caractere fora de Latin-1 ou passar de N caracteres, usa clipboard do
   Electron (`clipboard.writeText`) + `ctrl+v`, e restaura o clipboard anterior.
   Base: `input_control.py:111-136`.
4. **`killSwitch`**: JSON `{stopped, stopped_at, reason}` lido antes de cada
   ação `exec` e exposto como botão global; complementa o `AbortSignal`. Base:
   `safety.py:20-88`.
5. **Testes**: ranking com fixture de árvore (300 nós, 3 clusters, 1 botão sem
   nome), projeção com origem negativa e `scale=0.5`, e digitação CJK com
   backend falso. Nenhum precisa de desktop real.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/computer-use/CarlosShao--win-computer-use rev-parse HEAD
e4b15d56dfc5b01ca19fac79116b90c71f0979f7
$ grep -n "SetProcessDpiAwareness\|SetProcessDPIAware" win_computer_use/platform_util.py
34:  ctypes.windll.shcore.SetProcessDpiAwareness(2)
38:  ctypes.windll.user32.SetProcessDPIAware()
60:  user32.SetProcessDPIAware()
$ grep -n "def _ok\|_ok(\"lock\"" win_computer_use/server.py
55:def _ok(data: Any = None) -> JSONResponse:
540:  return _ok("lock", {"active": True, "message": "Already locked"})
$ grep -n "^from \.\|^from \.\." win_computer_use/ocr.py win_computer_use/input_control.py \
    win_computer_use/markers.py
win_computer_use/ocr.py:26:from . import screen
win_computer_use/input_control.py:20:from . import safety
win_computer_use/markers.py:36:from . import platform_util as _platform
win_computer_use/markers.py:39:from .screen import screenshot as _raw_screenshot
$ grep -n "import screen\|import safety" scripts/ocr.py scripts/input_control.py
scripts/ocr.py:26:import screen
scripts/input_control.py:20:import safety
$ grep -rn "pytest\|unittest" --include=*.py . | wc -l
0
```

Leituras feitas: `README.md`, `SKILL.md`, `NOTES.md`, `ROADMAP.md`,
`TEST_PLAN.md`, `pyproject.toml`, `win_computer_use/*.py` (17 arquivos) e
`scripts/{cli,ocr,input_control,screen}.py` para confirmar a duplicação.
Nada foi instalado ou executado.
