# PyAutoGUI

| Campo | Valor |
|---|---|
| Repositório | https://github.com/asweigart/pyautogui |
| Clone local | `repositorios/_research/computer-use/asweigart--pyautogui` |
| Commit | `b4255d0be42c377154c7d92337d7f8515fc63234` (2023-06-07) |
| Licença | BSD-3-Clause (`LICENSE.txt:1-20`; `setup.py:27`) |
| Categoria | computer-use (biblioteca de input; não é agente) |
| Stack | Python 2/3 (`setup.py:24`), ctypes puro no Windows; pyscreeze, pygetwindow, pymsgbox, pytweening, mouseinfo (`setup.py:30-38`); sem build step |
| Tamanho | 38 arquivos; 9 `.py`; ~4.618 linhas Python; `pyautogui/__init__.py` tem 2.171 linhas; 1 arquivo de teste com 28 testes |

## 1. O que é (verificado no código)

É a biblioteca de referência de **input sintético** em Python: mover/clicar,
segurar botão, arrastar, rolar, teclas e atalhos, além de screenshot e
localização de imagem via pyscreeze (`pyautogui/__init__.py:179-242`). Não tem
agente, loop, servidor, UI Automation, OCR ou gerenciamento de janelas próprio —
janelas vêm do pygetwindow (`:284-312`) e screenshot vem do pyscreeze
(`setup.py:36`), ambos fora deste repositório.

O entrypoint de biblioteca é o import: o módulo escolhe a implementação de
plataforma em `__init__.py:536-544` e carrega `_pyautogui_win.py` no Windows. O
único entrypoint de processo é `pyautogui/__main__.py:1-2`, que apenas chama
`displayMousePosition()` — não há CLI de comandos.

O README promete automação multiplataforma; o código confirma, mas com uma
assimetria importante: o backend Windows é `ctypes` próprio (573 linhas), o de
macOS usa Quartz (`_pyautogui_osx.py:5-7`) e o de Linux usa Xlib
(`_pyautogui_x11.py:1-8`). Nada disso é reaproveitável em TypeScript; o valor
está nas **regras** (mapa de teclas, failsafe, tween), não na implementação.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pip install pyautogui` | `setup.py:18-62` | instala a lib e as dependências por plataforma |
| `python -m pyautogui` | `pyautogui/__main__.py:1-2` | mostra posição do mouse (bloqueia até Ctrl-C) |
| `python -m unittest tests.test_pyautogui` | `tests/test_pyautogui.py:1-20` | suíte única; exige desktop real |
| `pyautogui.moveTo(x, y, duration=0.2, tween=...)` | `__init__.py:1261-1291`, `:1417-1514` | move com interpolação |
| `pyautogui.click(x, y, clicks, interval, button)` | `__init__.py:949-1003` | move e clica N vezes |
| `pyautogui.dragTo / dragRel` | `__init__.py:1325-1415` | arrasta segurando o botão |
| `pyautogui.scroll(clicks, x, y)` / `hscroll` | `__init__.py:1175-1258` | roda do mouse |
| `pyautogui.press / keyDown / keyUp / hold` | `__init__.py:1542-1655` | teclas e contexto de tecla segurada |
| `pyautogui.typewrite / write` | `__init__.py:1657-1690` | digita caractere por caractere |
| `pyautogui.hotkey('ctrl','s')` | `__init__.py:1693-1729` | chord com release em ordem inversa |
| `pyautogui.screenshot / locateOnScreen / locateAllOnScreen / center` | `__init__.py:181-242` | delega ao pyscreeze |
| `pyautogui.run("ccg-20,+0c")` | `__init__.py:2089-2148` | mini-linguagem de comandos |
| `pyautogui.displayMousePosition()` | `__init__.py:1739-1777` | loop de X/Y + cor do pixel |

Configuração de comportamento é por **globais do módulo**, não por arquivo:
`PAUSE` (`:562`), `FAILSAFE`/`FAILSAFE_POINTS` (`:572-573`, `:2170-2171`),
`MINIMUM_DURATION` (`:556`), `LOG_SCREENSHOTS`/`LOG_SCREENSHOTS_LIMIT`
(`:575-579`), além de `useImageNotFoundException()` (`:267-281`).

## 3. Arquitetura e fluxo

```
import pyautogui
  → escolhe platformModule = _pyautogui_win | _osx | _x11     (__init__.py:536-544)
  → funções públicas aplicam policy: failSafeCheck + PAUSE      (__init__.py:585-598)
  → platformModule._moveTo/_click/_keyDown/...                  (_pyautogui_win.py:250-573)
  → ctypes SetCursorPos / mouse_event / keybd_event             (_pyautogui_win.py:357-500)

screenshot/locate → pyscreeze → PIL ImageGrab                  (__init__.py:179-242)
janelas          → pygetwindow                                 (__init__.py:284-312)
```

- Entry point: `__init__.py:536-544` (seleção de plataforma); `_pyautogui_win.py:1-19`.
- "Loop": não existe. A única orquestração é `run()` (`__init__.py:2089-2148`),
  um parser de string que chama `click/moveTo/press/write/...` em sequência.
- Execução de primitiva: `_pyautogui_win.py:250-292` (keyDown),
  `:357-372` (SetCursorPos), `:432-500` (click e `mouse_event`).
- Streaming: não existe.
- Persistência: só arquivos de screenshot opcionais (`__init__.py:706-749`);
  nenhum estado entre processos.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `position` / `size` / `onScreen` | `__init__.py:752-809` | cursor, resolução e bounds **do monitor primário** | baixo |
| `moveTo` / `moveRel` / `move` | `__init__.py:1261-1323` | move com `duration` e `tween` | alto |
| `click` / `leftClick` / `rightClick` / `middleClick` | `__init__.py:949-1088` | clique simples/múltiplo | alto |
| `doubleClick` / `tripleClick` | `__init__.py:1090-1173` | cliques repetidos com `interval` | alto |
| `mouseDown` / `mouseUp` | `__init__.py:883-947` | segurar/soltar botão (seleção, drag manual) | alto |
| `dragTo` / `dragRel` / `drag` | `__init__.py:1325-1415` | arrastar segurando botão | alto |
| `scroll` / `hscroll` / `vscroll` | `__init__.py:1175-1258` | roda vertical/horizontal | alto |
| `keyDown` / `keyUp` / `press` / `hold` | `__init__.py:1542-1655` | teclas e contexto de hold | alto |
| `typewrite` / `write` | `__init__.py:1657-1690` | digita caractere por caractere | alto |
| `hotkey` / `shortcut` | `__init__.py:1693-1729` | chord com modificadores | alto |
| `screenshot` / `pixel` / `pixelMatchesColor` | `__init__.py:181`, `:232-242` | reexporta pyscreeze | baixo |
| `locateOnScreen` / `locateAllOnScreen` / `locateOnWindow` | `__init__.py:196-218` | template matching (OpenCV se `confidence`) | médio |
| `run` | `__init__.py:2089-2148` | DSL de string (`c`, `gX,Y`, `k'key'`…) | alto |
| `failSafeCheck` | `__init__.py:1732-1736` | aborta se o cursor está num canto | baixo |
| `alert/confirm/prompt/password` | `__init__.py:150-159` | reexporta pymsgbox | baixo |
| Log de screenshot por chamada | `__init__.py:706-749` | grava PNG antes de cada ação, mantém 10 | baixo |

## 5. Loop do agente, contexto e streaming

Não há agente. A camada de "policy" é o decorator `_genericPyAutoGUIChecks`
(`__init__.py:585-598`): antes de cada função pública chama `failSafeCheck()`,
depois dorme `PAUSE`. É o único ponto cross-cutting — e ele **não** valida
limites, não pede confirmação e não registra em log estruturado.

`run()` (`:2089-2148`) é a única composição: tokeniza a string
(`_tokenizeCommandStr`, `:1905-2029`), executa em ordem (`_runCommandList`,
`:2031-2087`) e restaura `PAUSE` ao final (`:2145-2147`). Não há condicional,
espera por elemento, retry ou captura de erro por passo: uma exceção interrompe
a string inteira.

Contexto: nada. O chamador precisa saber as coordenadas ou uma imagem de
template; a biblioteca nunca devolve uma descrição da tela além da imagem.

## 6. Sessões, estado e persistência

Sem sessões. O estado é global de processo:

| Estado | Onde | Observação |
|---|---|---|
| `PAUSE` | `__init__.py:562` | pausa após cada chamada; `run()` restaura |
| `FAILSAFE` | `__init__.py:572` | ligado por padrão |
| `FAILSAFE_POINTS` | `:573`, `:2170-2171` | 4 cantos calculados **uma vez** a partir do primário |
| `LOG_SCREENSHOTS` / limite / nomes | `:575-579`, `:743-749` | ring de 10 arquivos em disco |
| `USE_IMAGE_NOT_FOUND_EXCEPTION` (pyscreeze) | `:267-281` | muda o contrato de `locate*` de `None` para exceção |

Nada é persistido entre execuções; não há arquivo de configuração nem
versionamento.

## 7. Configuração e extensibilidade

Configuração = atribuir globais (`pyautogui.PAUSE = 0`, `pyautogui.FAILSAFE =
False`) ou passar `duration`/`tween`/`interval` por chamada. `tween` é qualquer
função `[0,1] → [0,1]` (`:617-628`); `pytweening` é opcional e o fallback é
`linear`.

Extensibilidade real: trocar a implementação de plataforma (`platformModule`) e
passar uma função de tween. Não há plugins, hooks, MCP, skills ou registro de
comandos. A biblioteca é importada, não configurada.

## 8. Permissões, sandbox e erros

**Não há permissões.** Qualquer código que importe a lib controla o mouse e o
teclado do usuário. As proteções são:

1. `FAILSAFE`: se `tuple(position())` estiver em `FAILSAFE_POINTS`, levanta
   `FailSafeException` (`:1732-1736`). Os pontos são os quatro cantos do
   **monitor primário**, calculados no import (`:2170-2171`) — um monitor à
   esquerda (x negativo) não tem canto protegido.
2. `PAUSE` de 0,1 s entre chamadas (`:562`, `:631-639`), que reduz (não elimina)
   cliques acidentais.
3. `_mouse_is_swapped()` existe (`_pyautogui_win.py:461-464`), mas
   `_normalizeButton` não o usa (`__init__.py:846-847`): `PRIMARY`/`SECONDARY`
   mapeiam para esquerdo/direito fixos, sem consultar o estado de troca.

Erros: `ImageNotFoundException` (opcional), `FailSafeException`,
`PyAutoGUIException` para argumentos inválidos. Não há timeout, cancelamento,
limite de taxa ou verificação de que a ação teve efeito. Falhas de
`mouse_event` são **engolidas** (`_pyautogui_win.py:397-401`, `:426-429`,
`:454-458`, `:538-541`) — o chamador acha que clicou.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| `TestGeneral` | `tests/test_pyautogui.py:92-257` | nomes acessíveis, `size`, `position`, `onScreen`, `PAUSE` |
| `TestHelperFunctions` | `:259-271` | `_normalizeXYArgs` |
| `TestDoctests` | `:272-276` | doctests do módulo |
| `TestMouse` | `:277-458` | move, tween, drag, scroll, botões |
| `TestRun` | `:460-621` | tokenizador da DSL |
| `TestKeyboard` | `:660-808` | typewrite, press, hold, shift |
| `TestFailSafe` | `:810-845` | cantos e desligamento |
| `TestPyScreezeFunctions` | `:847-878` | apenas o caminho "não encontrado" de `locate*` |

São 28 testes, todos de **desktop real**: `TestMouse.setUp` desliga o failsafe e
move o cursor para o centro (`:291-297`) e o comentário avisa que mexer no mouse
quebra a suíte (`:278`). Não há CI no repositório, nem teste de DPI,
multi-monitor, layout de teclado ou Unicode. É uma suíte de fumaça, não de
regressão.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Tabela de nomes de tecla + VK (inclui numpad, mídia, browser, OEM) | `_pyautogui_win.py:113-247` | cobre ~190 nomes; nosso `normalizeKeyChord` só tem 24 aliases (`layer.ts:104-137`) | BSD-3 | `src/core/computer/keymap.ts` | 22 |
| Caminho de ponteiro com `duration` + `tween` e passo mínimo | `__init__.py:1417-1514`, `:605-628` | arrasto/hover suave passa por apps com limiar de movimento | BSD-3 | `src/core/computer/pointer-path.ts` | 19 |
| `hold()` (down/up em contexto, release garantido em `finally`) | `__init__.py:1621-1655` | seleção com Shift e drag de tecla não existem hoje (só chord fechado) | BSD-3 | `src/core/computer/layer.ts` | 18 |
| Ring de screenshots antes/depois por ação | `__init__.py:706-749` | fecha a lacuna "events.jsonl sem antes/depois" (`GAP_ANALYSIS.md:167`) | BSD-3 | `src/core/computer/audit.ts` | 17 |
| Failsafe de canto + `PAUSE` global | `__init__.py:572-573`, `:1732-1736` | kill switch físico que não depende do foco do app | BSD-3 | `src/core/computer/input-guard.ts` | 15 |
| `useImageNotFoundException()` (contrato explícito de "não achou") | `__init__.py:267-281` | evita `undefined` silencioso em `locate` | BSD-3 | — (padrão de API) | 9 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| A biblioteca em si | Python + ctypes; nosso núcleo é TS e o backend já existe |
| `mouse_event` / `keybd_event` | APIs legadas; `SendInput` é o caminho correto e já usamos |
| `_size()`/`onScreen`/`FAILSAFE_POINTS` | assumem **um** monitor; nosso `CaptureInfo` já cobre desktop virtual (`layer.ts:36-44`, `:643-701`) |
| `typewrite` para texto real | `VkKeyScanA` só cobre 32–127 e depende do layout; caracteres fora disso são **descartados em silêncio** (`_pyautogui_win.py:246-247`, `:264-265`) |
| pyscreeze / PIL ImageGrab | screenshot externo, lento e sem metadados de origem/scale |
| `run()` DSL | o modelo já emite tool calls; uma string própria é uma segunda linguagem |
| `_normalizeButton` | ignora botões trocados (TODO em `:846-847`); nosso enum já é explícito |
| `alert/confirm/prompt` | pymsgbox não tem lugar num app Electron |
| Suíte de testes | interativa e dependente do mouse do usuário; não serve de oráculo |
| `displayMousePosition` | substituído por overlay/inspeção da UI |

## 12. Modelo de exemplo para o nosso harness

1. **`keymap.ts`**: tabela `name → {vk, shift?, extended?}` com os nomes que o
   modelo usa (`pageup`, `pagedown`, `num5`, `browserback`, `volumeup`,
   `printscreen`, pontuação OEM) e um normalizador que aceita as formas do
   xdotool (`Page_Up`), do pyautogui (`pgup`) e do Windows (`VK_PRIOR`).
   Fonte: `_pyautogui_win.py:113-247`. Integrar em `normalizeKeyChord`
   (`src/core/computer/layer.ts:104-137`) sem mudar o contrato atual.
2. **`pointerPath`**: `moveTo(from, to, {duration, tween})` com passo mínimo de
   16 ms e cancelamento por `AbortSignal`; usar em `computer_mouse_move`,
   `computer_drag` e no clique por coordenada. Base: `__init__.py:1417-1514`.
   Regra: se `duration > 0`, checar o abort **entre** passos.
3. **`InputGuard`**: (a) rejeitar coordenada fora do `CaptureInfo` — já existe
   em `layer.ts:543-555`; (b) limite de cliques por segundo; (c) kill switch
   quando o cursor entra num canto configurável, com aviso na UI antes de ligar;
   (d) `hold`/`release` com `finally` para nunca deixar tecla presa. Base:
   `__init__.py:1732-1736` + `:1621-1655`.
4. **`audit.ts`**: para cada tool `exec`, guardar `before` e `after` (PNG
   reduzido + hash do snapshot) num ring de N entradas por sessão, referenciado
   pelo `events.jsonl`. Base: `__init__.py:706-749`; resolve
   `GAP_ANALYSIS.md:167`.
5. **Testes**: mapa de teclas por snapshot (nome → VK), caminho de ponteiro com
   relógio falso (n passos, último ponto exato, abort no meio), `hold` que
   libera em exceção, e guard que recusa clique fora da captura. Nenhum toca o
   desktop.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/computer-use/asweigart--pyautogui rev-parse HEAD
b4255d0be42c377154c7d92337d7f8515fc63234
$ grep -n "__version__" pyautogui/__init__.py
16:__version__ = "0.9.54"
$ grep -n "SetProcessDPIAware" pyautogui/_pyautogui_win.py
17:   ctypes.windll.user32.SetProcessDPIAware()
$ grep -n "def _size\|GetSystemMetrics(0)" pyautogui/_pyautogui_win.py
348:def _size():
354:    return (ctypes.windll.user32.GetSystemMetrics(0), ctypes.windll.user32.GetSystemMetrics(1))
$ grep -n "MOUSEEVENTF_ABSOLUTE\|mouse_event(ev" pyautogui/_pyautogui_win.py
46:MOUSEEVENTF_ABSOLUTE = 0x8000
500:    ctypes.windll.user32.mouse_event(ev, ctypes.c_long(convertedX), ctypes.c_long(convertedY), dwData, 0)
$ grep -n "FAILSAFE_POINTS.extend\|_right, _bottom" pyautogui/__init__.py
2170:_right, _bottom = size()
2171:FAILSAFE_POINTS.extend([(0, _bottom - 1), (_right - 1, 0), (_right - 1, _bottom - 1)])
$ grep -n "VkKeyScanA\|def _keyDown" pyautogui/_pyautogui_win.py
247:    keyboardMapping[chr(c)] = ctypes.windll.user32.VkKeyScanA(ctypes.wintypes.WCHAR(chr(c)))
250:def _keyDown(key):
264:    if key not in keyboardMapping or keyboardMapping[key] is None:
265:        return
$ grep -n "def typewrite\|write = typewrite" pyautogui/__init__.py
1658:def typewrite(message, interval=0.0, logScreenshot=None, _pause=True):
1690:write = typewrite
$ grep -rn "pytest\|unittest" tests/test_pyautogui.py | wc -l
41
$ grep -c "    def test_" tests/test_pyautogui.py
28
$ ls .github 2>/dev/null || echo "no CI"
no CI
```

Leituras feitas: `README.md`, `setup.py`, `LICENSE.txt`, `CHANGES.txt`,
`pyautogui/{__init__,_pyautogui_win,__main__}.py`, `tests/test_pyautogui.py`,
`docs/{screenshot,keyboard,mouse}.rst` e `tox.ini`. Nada foi instalado ou
executado.
