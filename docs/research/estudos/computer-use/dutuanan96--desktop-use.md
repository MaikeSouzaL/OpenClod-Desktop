# desktop-use

| Campo | Valor |
|---|---|
| Repositório | https://github.com/dutuanan96/desktop-use |
| Clone local | `repositorios/_research/computer-use/dutuanan96--desktop-use` |
| Commit | `522d4488cd1ade31e5f08fb0bdf7222f62c1d150` (2026-06-16) |
| Licença | MIT (`LICENSE:1-3`) |
| Categoria | computer-use (bridge HTTP/WebSocket para desktop Windows) |
| Stack | Python ≥ 3.10 (`pyproject.toml:11`); FastAPI + uvicorn, pyautogui, mss, pygetwindow, pywin32, RapidOCR, OpenCV, requests, websockets, Pillow, numpy (`:28-41`); hatchling |
| Tamanho | 21 arquivos; 16 `.py`; ~3.889 linhas Python; 3 arquivos de teste; CI em 3 jobs |

## 1. O que é (verificado no código)

É um **bridge**: um servidor FastAPI roda no Windows e expõe o desktop como uma
API de comandos; um cliente Python (`DesktopAgent`) roda em qualquer lugar (WSL,
Linux, Docker) e fala HTTP com ele. O alvo declarado é permitir que um agente em
WSL controle aplicativos nativos (`README.md:21-29`).

O ponto de entrada real é `desktop_use/__main__.py:7-32` (`desktop-use serve`),
que grava as flags em variáveis de ambiente e chama `server.main()`
(`server.py:1368-1392`). O servidor sobe o uvicorn na thread principal e tenta
subir um WebSocket em uma thread separada (`:1388-1392`).

Duas promessas do README não se sustentam no código:

- **WebSocket "real-time streaming"** (`README.md:45`): o handler foi escrito
  para a API do FastAPI (`await websocket.accept()`, `receive_text()`,
  `send_json()` — `server.py:1310-1334`), mas é passado ao
  `websockets.serve()` (`:1356-1359`), cuja conexão não tem esses métodos. O
  `accept()` está **fora** do `try` (`:1317`), então a exceção mata a conexão.
  Além disso, o app FastAPI não registra nenhuma rota `@app.websocket` — não há
  caminho válido para esse handler.
- **Virtual display / `setup_workspace`** (`README.md:548-584`): o método não
  existe em `client.py` (nenhuma ocorrência de `setup_workspace` no pacote) e as
  funções de monitor (`server.py:871-947`) são código morto, sem chamada em
  `execute_command`.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pip install -e ".[dev]"` | `pyproject.toml:43-51` | instala servidor + cliente + pytest/ruff/httpx |
| `desktop-use serve [--host --port --ws-port]` | `__main__.py:17-30` | sobe HTTP (8765) e tenta WS (8766) |
| `python -m desktop_use.server` | `server.py:1395-1396` | mesmo efeito, ignorando as flags do CLI |
| `python -m desktop_use.client health` | `client.py:686-716` | CLI do cliente |
| `python -m desktop_use.client screenshot [--ocr] [--save] [--region]` | `client.py:686-729` | captura e opcionalmente OCR |
| `python -m desktop_use.client click X Y` | `client.py:757-762` | clique global |
| `python -m desktop_use.client find_text "..."` | `client.py:735-740` | OCR + melhor correspondência |
| `curl -X POST /action -d '{"action":"click","x":1,"y":2}'` | `server.py:1226-1235` | comando único |
| `curl -X POST /batch -d '{"commands":[...]}'` | `server.py:1238-1253` | lote com parada no primeiro erro |
| `curl /health` `/windows` `/mouse` `/screen_size` | `server.py:1210-1300` | leitura de estado |
| `pytest tests/ -v` | `.github/workflows/ci.yml:47-48` | suíte unitária com stubs |

Superfície: **26 ações** em `execute_command` (`server.py:950-1196`) — 4 de
captura/OCR, 2 de template, 5 de janela, 6 de mouse, 4 de teclado/scroll, 2 de
clipboard e 3 de sistema (`get_screen_size`, `wait`, `batch`). O cliente espelha
quase todas (`client.py:198-606`), além de `run_script` (`:608-621`), que o
servidor **não implementa** (cai em "Unknown action", `server.py:1188-1189`).

## 3. Arquitetura e fluxo

```
desktop-use serve
  → __main__.main() grava env → server.main()          (__main__.py:24-30)
  → _prewarm_ocr() + screenshot inicial                (server.py:1381-1386)
  → thread: websockets.serve(ws_handler)               (server.py:1350-1366)
  → uvicorn.run(app)                                   (server.py:1392)

POST /action → execute_command(cmd)                    (server.py:1226-1235)
  → screenshot | OCR | template | window | pyautogui | win32 PostMessage
  → {"success": bool, "data"|"error": ...}             (server.py:1191-1196)
```

- Entry point: `__main__.py:7-32`; servidor: `server.py:1368-1392`.
- Dispatch: `execute_command` (`server.py:950-1196`), um `if/elif` por ação.
- Execução: pyautogui (`:1078`, `:1089`, `:1144`), win32 PostMessage
  (`:625-732`), PowerShell (`:191-203`), mss (`:272-293`).
- Streaming: **não há**. Toda resposta é um JSON completo; o WS, que faria
  streaming, está quebrado (§8).
- Persistência: PNGs e templates em `~/desktop-use/` (`:63-69`), log em arquivo
  (`:75-83`), nenhum estado de sessão.

O cliente é um `requests` fino: `_post` monta `{"action": ..., **kwargs}`
(`client.py:118-154`), `_get` para os endpoints de leitura (`:155-180`). Não há
retry, fila, cancelamento ou timeout por ação (só o timeout global de 30 s,
`:61`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `screenshot` | `server.py:973-991` | mss no monitor primário; `ocr` e `base64` opcionais | baixo |
| `ocr` | `server.py:994-998` | OCR de arquivo ou da tela | baixo |
| `find_text` / `find_all_text` | `server.py:1000-1025` | substring case-insensitive sobre o OCR | baixo |
| `find_template` / `find_all_templates` | `server.py:1028-1046` | OpenCV `TM_CCOEFF_NORMED`; dedup por metade do template | médio |
| `focus_window` | `server.py:1049-1051`, `527-545` | `activate()`; fallback **Alt+Tab** | médio |
| `get_windows` / `get_active` | `server.py:1053-1057` | pygetwindow com geometria e flag `active` | baixo |
| `resize_window` / `move_window` | `server.py:1059-1067` | `resizeTo`/`moveTo` | médio |
| `click` / `double_click` / `right_click` | `server.py:1070-1101` | pyautogui; com `window_title`, PostMessage | alto |
| `move` | `server.py:1103-1110` | pyautogui `moveTo` com duração | alto |
| `drag` | `server.py:1112-1119` | `moveTo` + `drag` relativo | alto |
| `type` | `server.py:1126-1134` | clipboard + `ctrl+v`; PostMessage se `window_title` | alto |
| `hotkey` / `press` | `server.py:1136-1149` | pyautogui ou PostMessage | alto |
| `scroll` | `server.py:1151-1158` | pyautogui no ponto ou no cursor | alto |
| `clipboard_set` / `clipboard_get` | `server.py:1161-1166` | PowerShell `Set-Clipboard`/`Get-Clipboard` | médio |
| `get_screen_size` / `get_mouse` / `wait` | `server.py:1121-1176` | leitura e sleep | baixo |
| `batch` | `server.py:1178-1186` | sequencial, para no primeiro erro, 100 ms entre passos | alto |
| PostMessage click/type/hotkey | `server.py:625-720` | input sem mover cursor e sem foco | alto |
| `run_script` (cliente) | `client.py:608-621` | declara executar Python no servidor (não implementado) | **alto** |

## 5. Loop do agente, contexto e streaming

Não há loop de agente, prompt, compactação ou decisão: o repositório é um
**RPC**. Quem itera é o agente externo; `examples/ai_agent_loop.py:1-90` mostra o
formato esperado (screenshot → OCR → LLM → ação). Não há contexto nem histórico.

O que existe de "controle de fluxo": `batch` com parada no primeiro erro e
100 ms entre passos (`server.py:1178-1186`, repetido em `/batch` com 50 ms,
`:1238-1253`); timeout único de 30 s no cliente (`client.py:61`), inclusive para
OCR de tela cheia; e `FAILSAFE` do pyautogui (`server.py:103`) traduzido para
`{"success": false, "error": "FAILSAFE"}` (`:1191-1193`).

Cancelamento: não há. Um `wait` de 30 s ou um OCR lento não pode ser abortado
pelo cliente. Streaming: o WS pretendido não funciona (§1) e não há SSE.

## 6. Sessões, estado e persistência

Não há sessões nem retomada. O estado é só de arquivos:

| Estado | Onde | Observação |
|---|---|---|
| Screenshots | `~/desktop-use/screenshots` (`server.py:63-65`) | nome `screen_AAAAMMDD_HHMMSS.png` (`:265-267`); duas capturas no mesmo segundo sobrescrevem |
| Templates | `~/desktop-use/templates` (`:65`) | `_resolve_template` aceita caminho absoluto **ou** nome dentro da pasta (`:741-745`) — path traversal por `../` não é bloqueado |
| Log | `~/desktop-use/desktop_use.log` (`:66`, `:75-83`) | sem rotação |
| Frames | `ScreenBuffer` (`:802-864`) | nunca iniciado: `start()` não é chamado em nenhum ponto |

O diretório vem de `DESKTOP_USE_DATA_DIR` (`:63`) e é resolvido no import
(`:63-69`): mudar a env depois de importar não tem efeito.

## 7. Configuração e extensibilidade

| Chave | Onde | Padrão |
|---|---|---|
| `DESKTOP_USE_HOST` | `server.py:59` | `0.0.0.0` |
| `DESKTOP_USE_HTTP_PORT` | `:60` | `8765` |
| `DESKTOP_USE_WS_PORT` | `:61` | `8766` |
| `DESKTOP_USE_DATA_DIR` | `:63` | `~/desktop-use` |
| `--host/--port/--ws-port` | `__main__.py:18-20` | sobrescrevem via env antes do import |

Não há arquivo de configuração, plugins, hooks, MCP ou registro de ferramentas.
Adicionar uma ação exige editar três lugares: o `if/elif` (`server.py:950-1196`),
o cliente (`client.py:198-606`) e, se for endpoint próprio, o FastAPI
(`:1210-1300`). Não há tabela única de capacidades — logo, também não há como
listar as ações para o modelo.

## 8. Permissões, sandbox e erros

**Não há autenticação, autorização ou sandbox.** O host padrão é `0.0.0.0`
(`server.py:59`) e o uvicorn sobe com ele (`:1392`): qualquer máquina que
alcance a porta controla mouse, teclado, clipboard e arquivos. Não há token,
mTLS, allow-list de IP, CORS explícito ou verificação de origem. O README diz
"100% local — no data leaves your machine" (`README.md:25`), o que é verdade
apenas se a porta não estiver exposta — e o padrão a expõe.

Pontos específicos:

1. **Injeção em PowerShell** em `post_type` (`server.py:660-669`): o texto é
   escapado só para aspas duplas (`text.replace('"', '`"')`) e interpolado em
   `Set-Clipboard -Value "..."`. Um texto com `$(...)` executa subexpressão no
   PowerShell. O caminho global `clipboard_set` (`:211-217`) escapa aspas
   simples corretamente (`''`), então o defeito é só no caminho `window_title`.
2. **Path traversal em template** (`:741-745`): `../` resolve para fora de
   `templates/`; o caminho vai direto ao `cv2.imread`.
3. **`run_script`** no cliente (`client.py:608-621`) promete execução arbitrária
   de Python no servidor. Hoje é dead code (o servidor devolve "Unknown
   action"), mas o formato do contrato é perigoso.
4. **PostMessage não é isolamento**: `_find_hwnd` devolve `None` se a janela não
   for achada e o código **cai no pyautogui global** (`:1073-1078`,
   `:1128-1134`), movendo o cursor real — o oposto da promessa de "cursor does
   not move".
5. **`focus_window` com Alt+Tab** (`:543-545`): se `activate()` falha, o
   fallback alterna para a próxima janela — não necessariamente a pedida — e
   ainda devolve `success: True`.
6. **Erros**: `{"success": false, "error": str(exc)}` (`:1194-1196`) vaza
   caminho e mensagem interna; HTTP é sempre 200 (`:1235`), então o cliente
   depende do campo `success`.

O WebSocket, além de quebrado, repetiria a exposição: não há handshake de
autorização nem limite de comandos por conexão (`:1310-1334`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| `tests/test_server.py` | `tests/test_server.py:18-120` | `/health`, ação desconhecida, corpo vazio, `wait`, `get_screen_size`, `get_mouse` via ASGI |
| `tests/test_client.py` | `tests/test_client.py:10-147` | `_win_to_wsl`, init, `_post`/`_get`, métodos de alto nível com `requests` mockado |
| `tests/test___main__.py` | `tests/test___main__.py:1-40` | parser do CLI |
| `conftest.py` | `tests/conftest.py:12-60` | stubs de pyautogui, mss, pygetwindow, rapidocr |
| CI | `.github/workflows/ci.yml:10-62` | ruff + pytest em 4 Pythons (ubuntu e windows) + build |

O que **não** é coberto: captura real, offsets de região, OCR, template,
PostMessage, hotkey com modificadores, WebSocket e qualquer caminho que toque o
desktop. Os stubs fazem `pyautogui.click` virar `MagicMock`
(`conftest.py:23`), então os testes provam dispatch, não comportamento.

O job `ubuntu-latest` instala `.[dev]` (`ci.yml:37`), mas `pywin32` está nas
dependências obrigatórias sem marcador de plataforma (`pyproject.toml:34`) —
não há wheel para Linux, então esse job tende a falhar no `pip install` antes de
rodar teste. Não executei o CI (regra da tarefa); é uma leitura do manifesto.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| `computer_batch`: lote sequencial com parada no primeiro erro e resultado por passo | `server.py:1178-1186`, `:1238-1253` | reduz round-trips do modelo e devolve onde parou; combina com o "plan-first" | MIT | `src/core/tools/computer.ts` | 16 |
| Ações declaradas em tabela única (nome → handler → validação) | `server.py:950-1196` | hoje nosso catálogo é 19 `ToolDef` separados; uma tabela dá `list`/`describe` de graça | MIT | `src/core/computer/catalog.ts` | 16 |
| OCR pré-aquecido / engine única em memória | `server.py:120-139` | nosso `ocrImage` sobe um PowerShell por chamada (`src/core/media/ocr.ts:63-80`); manter o processo evita o custo de inicialização por leitura | MIT | `src/core/media/ocr.ts` | 13 |
| Anel de frames com `max_age` para preview | `server.py:802-864` | base para uma aba de "tela ao vivo" sem capturar a cada render | MIT | `src/main/computer/preview.ts` | 12 |
| Cliente fino com `{success, data, error}` e timeout único | `client.py:118-154`, `:57-61` | contrato previsível para ferramentas | MIT | — (já temos `ToolResult`) | 9 |
| Mapeamento de caminho Windows→WSL | `client.py:64-80` | útil só se o app rodar no WSL | MIT | — (não se aplica) | 3 |

## 11. O que vale NÃO portar

| Item | Motivo |
|---|---|
| Servidor HTTP inteiro | `0.0.0.0` sem auth; nosso harness roda no mesmo processo e usa IPC |
| WebSocket (`server.py:1310-1366`) | handler com API errada, `accept()` fora do `try`, sem rota FastAPI; não funciona |
| `post_click`/`post_type`/`post_hotkey` | já temos `click_method: 'app_post'` no backend (`src/core/computer/layer.ts:22`, `:367-375`), com a mesma política de snapshot e verificação pós-ação |
| `post_hotkey` | só aceita a última tecla + ctrl/shift/alt (`server.py:1142`); `alt+f4`, `win+…` e chord de 3 teclas saem errados |
| Virtual display (`server.py:871-947`) | código morto; `rect` é `[0,0,w,h]` para todo monitor (`:891`, `:902`), ignorando a posição real |
| `run_script` | contrato de execução arbitrária; não deve existir |
| PowerShell para clipboard | Electron tem `clipboard` nativo, sem injeção e sem processo |
| `focus_window` com Alt+Tab | não determinístico; melhor falhar explicitamente |
| Cliente `DesktopAgent` | dependência de rede para o que é chamada local |

## 12. Modelo de exemplo para o nosso harness

1. **`computer_batch`** (novo `ToolDef` em `src/core/tools/computer.ts`): schema
   `{ steps: [{ tool: 'computer_click'|'computer_type_text'|'computer_press_key'|..., args }] }`,
   executa em série, para no primeiro `ok:false`, e devolve
   `{ results: [{tool, ok, text, changed}], stopped_at }`. Regras: máximo de 20
   passos, cada passo passa pela mesma validação de schema e pela mesma política
   de permissão do tool individual (nada de bypass), e o `AbortSignal` é checado
   entre passos. Base: `server.py:1178-1186`.
2. **`catalog.ts`**: uma tabela `name → {risk, requires, schema, handler}` que
   gera os `ToolDef` e permite `computer_help`/listagem. Hoje o catálogo é um
   array manual (`computer.ts:755-775`) e a política repete nomes em
   `security/permissions.ts:185-249`; uma tabela única elimina a divergência.
   Base: `server.py:950-1196`.
3. **OCR persistente**: manter um processo PowerShell com um loop de leitura
   (stdin → caminho → JSON em stdout), em vez de `execFile` por imagem
   (`src/core/media/ocr.ts:63-80`). Ganho esperado: uma chamada por captura em
   vez de uma por OCR. Base: `_prewarm_ocr` (`server.py:130-139`).
4. **Preview**: `ScreenBuffer` de 2–3 frames, 2 fps, só enquanto a aba de
   Computer Use estiver visível; descartar ao esconder. Base:
   `server.py:802-864` (com `get_latest(max_age_ms)`).
5. **Testes**: tabela de dispatch com 100% das ações (nome desconhecido,
   argumento faltando, ação que lança), batch que para no erro, e um teste que
   garante que `computer_batch` **não** executa ferramenta fora da allow-list.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/computer-use/dutuanan96--desktop-use rev-parse HEAD
522d4488cd1ade31e5f08fb0bdf7222f62c1d150
$ ls desktop_use tests
desktop_use: __init__.py __main__.py client.py server.py
tests: __init__.py conftest.py test___main__.py test_client.py test_server.py
$ grep -n "HOST: str\|HTTP_PORT\|WS_PORT\|DATA_DIR" desktop_use/server.py | head -5
59:HOST: str = os.environ.get("DESKTOP_USE_HOST", "0.0.0.0")
60:HTTP_PORT: int = int(os.environ.get("DESKTOP_USE_HTTP_PORT", "8765"))
61:WS_PORT: int = int(os.environ.get("DESKTOP_USE_WS_PORT", "8766"))
63:_DATA_DIR = Path(os.environ.get("DESKTOP_USE_DATA_DIR", Path.home() / "desktop-use"))
$ grep -n "ws_lib.serve\|await websocket.accept\|@app.websocket" desktop_use/server.py
1317:    await websocket.accept()
1358:            server = await ws_lib.serve(ws_handler, HOST, WS_PORT)
$ grep -rn "setup_workspace" desktop_use | wc -l
0
$ grep -n "_screenshot_buffer.start\|get_windows_with_timeout(" desktop_use/*.py
server.py:495:def get_windows_with_timeout(timeout: float = 2.0) -> list:
$ grep -cE "^\s*(el)?if action ==" desktop_use/server.py
26
$ grep -n "escaped = text.replace" desktop_use/server.py
216:    escaped = text.replace("'", "''")
668:    escaped = text.replace('"', '`"')
$ grep -n "monitors\[1\]\|sct.monitors" desktop_use/server.py
281:                monitor = sct.monitors[1]
828:            monitor = sct.monitors[self.monitor]
858:            monitor = sct.monitors[self.monitor]
$ grep -n "def run_script\|\"run_script\"" desktop_use/client.py desktop_use/server.py
desktop_use/client.py:608:    def run_script(self, code: str) -> dict[str, Any]:
desktop_use/client.py:621:        return self._post("run_script", code=code)
$ grep -rn "pywin32" pyproject.toml
34:    "pywin32>=306",
```

Leituras feitas: `README.md`, `pyproject.toml`, `desktop_use/{__main__,server,client,__init__}.py`,
`tests/{conftest,test_server,test_client,test___main__}.py` e
`.github/workflows/ci.yml`. Nada foi instalado ou executado.
