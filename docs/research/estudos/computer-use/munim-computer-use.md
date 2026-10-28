# Munim Computer Use

| Campo | Valor |
|---|---|
| Repositório | https://github.com/munimtechnologies/munim-computer-use |
| Clone local | `repositorios/munim-computer-use` |
| Commit | `c7ce4fc9ae8abcf7e4869e3645b54953a3711e77` |
| Licença | Apache-2.0 (`LICENSE`; sem arquivo `NOTICE`) |
| Categoria | computer-use (novo, fora dos 55 originais) |
| Stack | Rust (Windows/Linux), Swift (macOS), JavaScript (extensão Chrome MV3), Node (launcher npm) |
| Tamanho | 88 arquivos fora do `.git`; ~1,39 MB de código (`.rs/.swift/.js/.mjs/.ts/.tsx`); 159 testes Rust + 56 testes da extensão |

## 1. O que é (verificado no código)

Servidor **MCP por stdio** que dá a um agente controle de desktop e do Chrome
logado do usuário. O núcleo é Rust (`windows-linux/src/main.rs`), com um par
Swift para macOS que fala o mesmo dialeto de ferramentas. Não é um harness de
programação: é o **backend de Computer Use** que um harness consome.

O diferencial está em quatro decisões de implementação:

1. **Acessibilidade primeiro, pixel depois.** `get_app_state` devolve uma árvore
   de UI Automation com ids estáveis (`e12`); screenshot é verificação.
2. **Input em background.** Eventos são endereçados à janela-alvo; o cursor do
   usuário não é tomado na maioria dos casos (README 168-180; `windows.rs:1727-1731`).
3. **`return_state`.** Qualquer ação pode devolver o estado novo na mesma
   chamada, com espera baseada em eventos de acessibilidade (`settle.rs`).
4. **Browser no Chrome real.** Extensão MV3 + native messaging abre um grupo de
   abas próprio, adota aba existente e protege credenciais (`background.js`).

## 2. Como executar e comandos reais

| Comando / modo | Onde está | O que faz |
|---|---|---|
| sem argumento | `main.rs:135-223` | Servidor MCP stdio: lê JSON-RPC por linha, responde em stdout |
| `native-host` | `main.rs:94-99` | Relay do Chrome native messaging (`browser.rs:1385`) |
| `install-native-host` | `main.rs:101-103` | Registra o host nativo no Chrome/Chromium (`install.rs`) |
| `check-native-host` | `main.rs:106-108` | Diagnostica por que o Chrome não acha o host (`host_check.rs`) |
| `identity` | `main.rs:111-114` | Imprime paths, nomes e perfil resolvidos |
| `computer-history --root <dir>` | `main.rs:116-133` | Daemon que grava histórico de app/foco em JSONL (`history.rs:41`) |
| `initialize` | `main.rs:259-269` | Negocia versão e devolve `serverInfo` + `instructions` |
| `tools/list` | `main.rs:270` | Lista as 32 ferramentas |
| `tools/call` | `main.rs:271` | Executa uma ferramenta |
| `ping` | `main.rs:273` | Responde `{}` |

Versões de protocolo aceitas: `2025-11-25`, `2025-06-18`, `2025-03-26`,
`2024-11-05`; qualquer outra cai para `2024-11-05` (`main.rs:44-46`, `236-243`).

### Ferramentas (32, agrupadas)

| Área | Ferramentas | Onde |
|---|---|---|
| Ver | `list_apps`, `get_app_state`, `screenshot`, `zoom`, `list_displays` | `tools.rs:56+` |
| Agir | `click`, `right_click`, `hover`, `drag`, `scroll`, `type_text`, `set_value`, `select_text`, `press_key`, `activate_app`, `wait` | `main.rs:702-837` |
| Clipboard | `clipboard_read`, `clipboard_write` | `main.rs:444-468`, `clipboard.rs` |
| Browser | `browser_open_tab`, `browser_list_tabs`, `browser_use_tab`, `browser_release_tab`, `browser_select_tab`, `browser_navigate`, `browser_snapshot`, `browser_read`, `browser_click`, `browser_type`, `browser_request_credentials`, `browser_press_key`, `browser_close_tab`, `browser_close_all_tabs` | `main.rs:361-372`, `browser.rs` |

Os schemas são **equivalentes entre Swift e Rust**, com uma exceção permitida
(`get_app_state.window` só existe no macOS), e um script de paridade
(`scripts/check-tool-parity.mjs`, README 301). O `title` é derivado de
`annotations.title` para clientes antigos e novos (`tools.rs:43-51`).

## 3. Arquitetura e fluxo

```
stdio JSON-RPC
  → dispatch(method)                         main.rs:252-276
  → call_tool(name, args)                    main.rs:349-487
      ├─ browser_* → BrowserBridge           browser.rs:577-695
      ├─ list_displays/screenshot/zoom       capture.rs
      ├─ clipboard_*                         clipboard.rs
      └─ Desktop trait                       platform/mod.rs
           ├─ WindowsDesktop (UIA + Win32)   platform/windows.rs
           └─ LinuxDesktop (AT-SPI + X11)    platform/linux.rs
  → text_result / image_result (isError)     main.rs:278-296
```

- Entry point: `main.rs:82` (`fn main`).
- Backend: `platform::backend()` em `main.rs:141`; se falhar, o servidor continua
  respondendo `initialize`/`tools/list` e explica o motivo (`main.rs:138-147`).
- Ferramenta: `run_desktop_tool` em `main.rs:702`.
- Erro de ferramenta: vai **dentro do resultado** com `isError: true`, não como
  erro JSON-RPC, para o modelo ler e tentar de novo (`main.rs:278-285`).
- Captura: `capture.rs` (xcap no Windows/Linux), com `catch_unwind` para não
  derrubar o servidor quando o compositor não é suportado (`capture.rs:21-30`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `get_app_state` | `main.rs:712-724` | Árvore UIA com ids, `query`, `offscreen`, `ocr`, limites de profundidade/elementos | baixo (leitura) |
| `click` / `right_click` | `main.rs:741-745` | Prefere `InvokePattern`; senão clique de fundo; senão cursor real | alto |
| `type_text` / `press_key` | `main.rs:751-772` | Texto literal ou chord de teclas; recusa campo de senha | alto |
| `set_value` / `select_text` | `main.rs:788-810` | Escreve/ seleciona via UIA, sem clique | médio |
| `scroll` | `main.rs:773-787` | ScrollPattern ou roda; aceita elemento ou coordenada | médio |
| `drag` / `hover` | `main.rs:725`, `746-750` | Arrasta/ passa o mouse com fallback de cursor | alto |
| `screenshot` | `main.rs:811-833` | Janela ou display, PNG/JPEG, largura máxima, legenda de mapeamento | baixo |
| `zoom` | `main.rs:489-508` | Região em resolução física, mínimo 4×4 | baixo |
| `list_displays` | `main.rs:377-382` | Monitores, posição, tamanho, primário | baixo |
| `list_apps` | `main.rs:711` | Apps, pid, janelas, frontmost | baixo |
| `activate_app` | `main.rs:726-740` | Traz app/janela para frente | médio |
| `clipboard_read/write` | `main.rs:444-468` | Texto puro, com limite de caracteres | médio |
| `browser_snapshot` | `background.js:741` | Snapshot do DOM com escopo de diálogo e paginação | baixo |
| `browser_read` | `background.js:1526` | Texto da página em chunks, com query e links | baixo |
| `browser_request_credentials` | `background.js:1744` | Usuário digita no Chrome; valor nunca volta ao modelo | médio |
| `browser_use_tab` / `release_tab` | `background.js:457`, `492` | Adota aba existente sem movê-la; devolve depois | médio |
| `computer-history` | `history.rs:41-150` | Amostra app/foco e grava segmentos JSONL | alto (privacidade) |

## 5. Loop do agente, contexto e streaming

Não há loop de LLM aqui: o servidor é **reativo**, uma chamada por vez no
stdio (`main.rs:159-223`). O que existe é um contrato de observação:

- **Ids por snapshot.** `get_app_state` registra os elementos; uma ação resolve
  o id e **recheca o fingerprint** (role + name) antes de agir. Se o elemento
  sumiu ou mudou, falha em vez de clicar em outra coisa (`windows.rs:154-181`).
- **`query` não para no limite.** Com `query`, a leitura percorre até 5.000
  elementos e o `max_elements` limita só a impressão; se a caminhada parou antes
  do fim, o texto diz que a busca está incompleta (`main.rs:525-600`, `651-668`).
- **Diálogos primeiro.** Quando um diálogo modal bloqueia a janela, só os
  controles dele são listados; o modelo não clica atrás (`windows.rs:895`,
  README 149).
- **`return_state`.** A ação espera o app parar de reagir e relê o estado no
  mesmo call (`main.rs:691-700`, `838-842`).
- **Settle por eventos.** Em vez de pausa fixa, conta WinEvents: 600 ms para a
  primeira reação, 150 ms de quietude, teto de 2 s, poll de 20 ms
  (`settle.rs:38-46`, `123-165`). Fontes que já disparavam antes da ação são
  tratadas como background e não contam (`settle.rs:64-102`).
- **Captura com mapa.** Toda imagem carrega origem, tamanho, pixels por unidade
  de tela e a fórmula de conversão; captura de cor única é sinalizada como
  possível bloqueio do SO (`capture.rs:174-214`).
- **DPI.** `use_physical_pixels()` roda antes de qualquer janela
  (`main.rs:87-90`; `windows.rs:1454`).
- **Sem streaming de token.** O transporte é linha a linha; imagens vão em
  base64 no content (`main.rs:287-296`).

## 6. Sessões, estado e persistência

| Estado | Onde | Vida |
|---|---|---|
| Registro de elementos | `WindowsDesktop.registry` (`windows.rs:72+`) | por snapshot; ids invalidam |
| Último app lido | `LAST_READ` (`main.rs:605-610`) | processo; usado por `return_state` |
| Aprovações `ask` | `policy.rs:176-212` | processo |
| Abas do agente | `background.js:83-118` | por `clientId`/`sessionId`, persistido em `chrome.storage` |
| Dono da ponte | `browser.rs:196-340` | primeiro processo vira dono; os demais falam com ele |
| Histórico | `history.rs:41+` | segmentos de 600 s em JSONL |

O bridge é um named pipe no Windows / Unix socket no Linux; o Chrome fala com
ele por native messaging (`browser.rs:59-138`, `827-996`). Vários processos MCP
compartilham a mesma extensão: o primeiro vira dono e os outros passam por ele
(`browser.rs:287-340`). Cada cliente tem seu **tab group** e só fecha as próprias
abas (`background.js:290-330`, `511-567`).

## 7. Configuração e extensibilidade

- `policy.json` em `%LOCALAPPDATA%\munim-computer-use` (ou
  `COMPUTER_USE_POLICY`) com `apps` e `sites` → `allow|ask|block`
  (`policy.rs:130-174`).
- Flags: `COMPUTER_USE_BROWSER=0`, `COMPUTER_USE_AGENT_CURSOR=0`,
  `COMPUTER_USE_ALLOW_SECURE_FIELD_INPUT=1`, `COMPUTER_USE_REMOTE_CONTROL=1`,
  `COMPUTER_USE_PARK_WINDOWS=0`, `COMPUTER_USE_POLICY` (README 360-370).
- Perfil de embedder por `--profile`/`COMPUTER_USE_PROFILE`, com `name`,
  `envPrefix`, `supportDir`, `bridgeSocket`, `historyDir`, `nativeHostNames`,
  `extensionIds` (README 391-421; `identity.rs:9-14`).
- Extensão Chrome MV3 com `tabs`, `tabGroups`, `debugger`, `nativeMessaging`,
  `scripting`, `alarms`, `storage` (`chrome-extension/manifest.json:8-17`).

## 8. Permissões, sandbox e erros

- **Política por app e site**: `allow`, `ask` (aprova uma vez por processo e
  expira em 2 min sem resposta) e `block` (`policy.rs:181-212`).
- **Fail-closed**: arquivo inválido bloqueia tudo que ele poderia liberar, em vez
  de ser ignorado (`policy.rs:158-170`, `89-99`).
- **Campo de senha**: recusado por padrão; só com
  `COMPUTER_USE_ALLOW_SECURE_FIELD_INPUT=1` (`windows.rs:312-314`).
- **Recusas explícitas**: elemento fora da janela/da tela, coberto por outra
  janela, janela minimizada, diálogo de segurança do Windows
  (`windows.rs:205-251`).
- **Erro in-band**: `isError: true` com texto acionável (`main.rs:278-285`).
- **Backend indisponível**: `initialize` e `tools/list` continuam funcionando,
  e as ferramentas explicam o motivo (`main.rs:138-147`).
- **Sandbox**: detecta low integrity/outro desktop e explica árvore vazia e
  captura preta (`README 356-358`; `capture.rs:174-190`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Rust | `windows-linux/src/**` (`#[test]`) | 159 testes: ids, política, settle, captura, teclas, DPI, árvore, browser |
| Extensão | `chrome-extension/background.test.mjs` | 56 testes contra Chrome falso; waits, site policy, tabs |
| Paridade | `scripts/check-tool-parity.mjs` | Schemas Swift × Rust idênticos |
| Snapshot/DOM | `scripts/snapshot-dom.test.mjs` | Escopo de diálogo, paginação, visibilidade |
| E2E browser | `scripts/e2e-browser.mjs` | Chrome descartável; diálogo atrasado, timeout, recuperação |

Os testes são uma parte explícita do desenho: o `settle.rs` tem um `Clock`
injetável (`settle.rs:104-165`), e a extensão testa o contrato de `wait_for_selector`
em vez de só o caminho feliz (README 266-279).

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| `return_state` + settle por eventos | `settle.rs:38-228`; `main.rs:691-700` | Elimina pausa fixa e leitura velha; mede reação real | Apache-2.0 | `src/core/computer/settle.ts` + opção em `computer_act` | 25 |
| Backend MCP alternativo | `main.rs:252-487`; `tools.rs:29-56` | Já fala MCP stdio; nosso `McpClient` sabe iniciar; dá Computer Use real sem reescrever Go | Apache-2.0 | `src/core/computer/layer.ts` (`backend: 'munim'`) | 25 |
| Mapa de captura + aviso de cor única | `capture.rs:174-214` | Corrige clique em DPI/escala e captura bloqueada | Apache-2.0 | `src/core/computer/layer.ts` (`CaptureInfo`) | 24 |
| Política app/site allow/ask/block | `policy.rs:1-212` | Guard rail que o usuário controla, fail-closed | Apache-2.0 | `src/core/security/computer-policy.ts` | 24 |
| Rechecagem de fingerprint do elemento | `windows.rs:154-181` | Nosso `element_stale` valida índice, não role/name | Apache-2.0 | `src/core/computer/layer.ts` | 23 |
| Tab group + adotar/devolver aba | `background.js:290-567` | Usa o Chrome logado sem roubar abas | Apache-2.0 | `src/core/browser/tab-session.ts` | 23 |
| Credenciais sem expor ao modelo | `background.js:1744+` | Senha nunca entra no transcript | Apache-2.0 | `src/core/browser/credentials.ts` | 22 |
| `query` além do teto + honestidade | `main.rs:525-600` | Busca completa, sem falso "não existe" | Apache-2.0 | `src/core/computer/snapshot.ts` | 22 |
| Escopo de diálogo | `windows.rs:895`; `background.js:741-752` | Evita clicar atrás de modal | Apache-2.0 | `src/core/computer/snapshot.ts` | 21 |
| OCR com ids acionáveis | `platform/ocr.rs`; `main.rs:99-103` | Apps sem UIA continuam controláveis | Apache-2.0 | `src/core/computer/ocr-targets.ts` | 21 |
| Negociação de versão MCP | `main.rs:44-46`, `236-243` | Nosso cliente está fixo em `2024-11-05` | Apache-2.0 | `src/core/mcp/client.ts` | 20 |
| Paridade de schema entre plataformas | `tools.rs:1-5`; `scripts/check-tool-parity.mjs` | Evita deriva entre backends | Apache-2.0 | `tests/computer-tool-parity.test.ts` | 20 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Implementação Rust/Swift inteira | Stack incompatível; 159 testes e COM/UIA exigiriam reescrita nativa |
| `history.rs` por padrão | Coleta contínua de app/foco é risco de privacidade; só com opt-in explícito |
| Agent cursor overlay | Polimento visual; não desbloqueia capacidade |
| Extensão com a `key` fixa do fabricante | Identidade/ID de extensão é do projeto deles; a nossa precisa de chave própria |
| macOS `WindowParking`/SkyLight | Específico de macOS; não temos alvo |
| Dependência `xcap` direta no Node | O backend já resolve captura; não adicionar dependência nativa sem necessidade |

## 12. Modelo de exemplo para o nosso harness

**Fase 1 — integrar como backend opcional, não reescrever.**
Criar em `src/core/computer/layer.ts` uma abstração `ComputerBackend` com duas
implementações: `open-computer-use` (atual) e `munim` (MCP stdio, spawn de
`munim-computer-use`). Configuração `computerBackend: 'auto' | 'ocu' | 'munim'`.
Mapear `computer_snapshot` → `get_app_state`, `computer_click` → `click`,
`computer_type` → `type_text`, `computer_key` → `press_key`, e usar
`return_state: true` quando o chamador pedir `observe_after`. Vantagem: ganha
input em background, settle e política sem tocar no código Go atual; o backend
antigo continua como fallback.

**Fase 2 — portar o comportamento que é nosso.**
`settle.ts` em TS puro com o mesmo algoritmo, mas com `probe` baseado em hash do
snapshot (poll de 20 ms, reação 600 ms, quietude 150 ms, teto 2 s). O hook de
WinEvents exato só é possível com código nativo; a versão TS entrega 80% do
ganho sem sidecar. Expor `observe_after` em `computer_click`, `computer_type`,
`computer_key` e `computer_scroll`.

**Fase 3 — política.**
`computer-policy.ts` com `{apps, sites}` e `allow|ask|block`, leitura por
mtime, fail-closed e aprovação ligada ao sistema de permissões existente
(`src/core/security/permissions.ts`). A regra de site só vale para o backend de
navegador; a de app vale para o Computer Use.

**Fase 4 — captura.**
Reusar `CaptureInfo` existente e acrescentar (a) origem/tamanho/pixels por
unidade na legenda, (b) aviso de captura de cor única, (c) recusa de clique
quando o centro do elemento está fora da janela ou coberto. Isso ataca
diretamente o defeito 4 do `GAP_ANALYSIS.md`.

**Fase 5 — browser (depois).**
Só vale a pena quando houver extensão própria: grupo de abas por sessão,
`use_tab`/`release_tab`, `request_credentials`, `wait_for_selector` com
`readiness`. É um projeto de 2–3 semanas, não uma porta de arquivo.

**Testes obrigatórios**: paridade de nomes/argumentos entre backends; settle com
relógio falso; política com arquivo inválido; captura com escala 0,5 e 2; clique
em elemento coberto; `return_state` sem leitura prévia.

## 13. Evidências da análise

```text
git -C repositorios/munim-computer-use rev-parse HEAD
c7ce4fc9ae8abcf7e4869e3645b54953a3711e77

Get-ChildItem ... -Recurse -File | Measure-Object
88 arquivos fora do .git (117 incluindo .git)

Select-String -Path windows-linux/src/**/*.rs -Pattern '#\[test\]'
159 ocorrências

Select-String -Path chrome-extension/background.test.mjs -Pattern '^\s*test\('
56 ocorrências

main.rs:44-46    versões de protocolo
main.rs:252-276  dispatch JSON-RPC
main.rs:278-285  erro in-band (isError)
main.rs:525-600  query além do limite
main.rs:691-700  return_state
settle.rs:38-46  tempos do settle
settle.rs:123-165 algoritmo de quietude
windows.rs:154-181 rechecagem de fingerprint
windows.rs:205-251 recusa fora da tela/coberto
windows.rs:285-308 Invoke/Toggle/SelectionItem
windows.rs:1727-1731 clique em background
capture.rs:174-214 mapa de captura e cor única
policy.rs:89-127   regras allow/ask/block
policy.rs:158-170  fail-closed
browser.rs:196-340  dono da ponte e peers
background.js:457-567 adotar/devolver/fechar abas
background.js:1744+ credenciais sem retorno de valor
history.rs:104-150 daemon de histórico
```
