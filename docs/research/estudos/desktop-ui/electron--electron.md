# Electron

| Campo | Valor |
|---|---|
| Repositório | https://github.com/electron/electron |
| Clone local | `repositorios/_research/desktop-ui/electron--electron` |
| Commit | `96a2dc1f28a4e4a32fdc19d54ba0af36c7f2c536` |
| Licença | MIT (`LICENSE:1-4`) |
| Categoria | desktop-ui (runtime desktop) |
| Stack | C++/Objective-C (Chromium embedder), TypeScript/JavaScript (API), GN/Ninja, Yarn (`package.json:3-28`) |
| Tamanho | 3.192 arquivos; ~289 mil linhas em `.cc/.h/.ts/.md` |

## 1. O que é (verificado no código)

Electron não é um aplicativo: é um **runtime embutidor do Chromium + Node.js**. O
produto é a API JavaScript que cria janelas, carrega páginas, expõe IPC e empacota
um app. O entrypoint "de aplicativo" é `default_app/default_app.ts`, que interpreta
`--app=`, `--interactive`, `--require` e cria uma `BrowserWindow` com
`contextIsolation: true`, `sandbox: true` e `nodeIntegration: false`
(`default_app/default_app.ts:87-101`). O bootstrap interno da API fica em
`lib/browser/init.ts:1-50`, que instala o hook de `require`, o handler de exceção
não capturada e redireciona `process.exit` para `app.exit`.

O núcleo de comportamento (processos, janelas, IPC, permissões) é C++ em
`shell/browser`; a camada JS em `lib/` é uma fachada fina. Neste commit a versão do
`package.json` raiz é `0.0.0-development` (`package.json:3`), ou seja, é a linha de
desenvolvimento, não uma release.

O ponto mais relevante para nós: a **dispatch de IPC saiu do JavaScript**. O antigo
fan-out em JS foi substituído por `electron_api_ipc_dispatch.cc`, que chama
`ipcMain`, `webContents.ipc` e `frame.ipc` diretamente no isolate
(`shell/browser/api/electron_api_ipc_dispatch.cc:578-659`). O `ipcMain` JS continua
sendo o mapa de handlers (`lib/browser/ipc-main-impl.ts:5-23`).

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `npm start` | `package.json:71` | compila/baixa o Electron e sobe o app padrão (`script/start.js`) |
| `npm test` | `package.json:72` | roda a suíte de specs (`script/spec-runner.js`) |
| `npm run bundle` | `package.json:74` | empacota o bundle de JS |
| `npm run typecheck` | `package.json:75` | typecheck do bundle |
| `npm run repl` | `package.json:70` | sobe o shell interativo do Electron |
| `npm run lint` | `package.json:41` | lint de JS, C++, docs, markdown e chromium roller |
| `electron --app=<dir>` | `default_app/main.ts:40-45` | executa um app a partir do diretório |
| `electron --interactive` | `default_app/main.ts:48-49` | REPL com a API do Electron |
| `electron --require <módulo>` | `default_app/main.ts:51-53` | pré-carrega um módulo no processo principal |
| `electron --version`, `--abi` | `default_app/main.ts:39-58` | versão e ABI do Node embutido |

A superfície de UX é de **biblioteca**, não de CLI: `app`, `BrowserWindow`,
`WebContentsView`, `ipcMain`, `ipcRenderer`, `contextBridge`, `protocol`,
`session`, `utilityProcess`, `safeStorage`, `autoUpdater`. O app padrão só existe
para demonstração e para rodar um `main.js` arbitrário.

## 3. Arquitetura e fluxo

```text
main process (Node + Chromium browser)
  → BrowserWindow / WebContentsView
  → renderer sandbox + preload isolado
  → contextBridge.exposeInMainWorld
  → ipcRenderer.invoke(channel, ...args)
  → IPC dispatcher C++ (electron_api_ipc_dispatch)
  → ipcMain._invokeHandlers / webContents.ipc / frame.ipc
  → Promise do handler → microtask → reply {result} | {error}
```

- Entry point do app: `default_app/default_app.ts:87-101`; bootstrap da API:
  `lib/browser/init.ts:1-50`.
- Processos: o modelo multi-processo é descrito em `docs/tutorial/process-model.md:24-40`
  (main, renderer, utility; cada renderer é um processo do Chromium).
- IPC: `lib/browser/ipc-dispatch.ts:1-7` entrega os objetos JS ao binding C++;
  a dispatch real está em `shell/browser/api/electron_api_ipc_dispatch.cc:578-659`
  (mensagens) e `:661-692` (invoke).
- `invoke`: `IpcMainImpl.handle` rejeita handler duplicado e não-função
  (`lib/browser/ipc-main-impl.ts:15-23`); o dispatcher procura o handler no frame,
  no `webContents.ipc` e no `ipcMain` (`electron_api_ipc_dispatch.cc:383-418`).
- Resposta: `RunInvokeHandler` aguarda Promise/thenable e responde em microtask
  (`electron_api_ipc_dispatch.cc:403-469`); erro de clone vira `{error}` em vez de
  derrubar o processo (`:262-278`).
- Streaming: **não existe stream nativo de IPC**. O padrão é `webContents.send`
  por evento + `ipcRenderer.on`; para fluxos grandes usa-se `MessageChannelMain`
  ou `utilityProcess` (`lib/browser/api/utility-process.ts:93-110`).
- Persistência: `session` (partição, cookies, cache, storage) e `safeStorage`;
  não há store de estado de app no runtime.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `BrowserWindow` | `lib/browser/api/browser-window.ts:4` | binding C++ da janela Chromium com `webPreferences` | alto se `sandbox`/`contextIsolation` errados |
| `WebContentsView` | `lib/browser/api/browser-view.ts:12-46` | view embutida; `BrowserView` virou wrapper dela | médio |
| `<webview>` | `lib/browser/guest-view-manager.ts:1` | guest view em processo separado | alto (precisa `will-attach-webview`) |
| `ipcMain.handle` | `lib/browser/ipc-main-impl.ts:15-23` | handler request/response por canal | alto (validar `senderFrame`) |
| `contextBridge` | `lib/renderer/api/context-bridge.ts:1-3` | expõe API limitada ao mundo isolado | médio |
| `protocol.handle` | `lib/browser/api/protocol.ts:154-188` | serve `app://` com handler próprio | baixo se escopado |
| `utilityProcess.fork` | `lib/browser/api/utility-process.ts:93-110` | processo Node auxiliar com stdio | médio |
| `session.setPermissionRequestHandler` | `docs/tutorial/security.md:272-310` | decide câmera, microfone, clipboard etc. | alto |
| `setWindowOpenHandler` | `lib/browser/api/web-contents.ts:92` | bloqueia/abre novas janelas | alto |
| `safeStorage` | `lib/browser/api/safe-storage.ts:1` | criptografia via keychain/DPAPI | baixo |
| `autoUpdater` | `lib/browser/api/auto-updater.ts:1` | atualização assinada | alto (cadeia de suprimentos) |

## 5. Loop do agente, contexto e streaming

Não há loop de agente. O que existe é um **loop de eventos** com duas filas: a do
Chromium (UI/renderer) e a do Node (main). A única "concorrência" relevante para
nós é a semântica de `invoke`:

1. O handler pode ser síncrono, assíncrono ou thenable; o dispatcher adota
   thenables e responde quando a Promise assenta (`electron_api_ipc_dispatch.cc:436-469`).
2. A resposta é enfileirada em microtask para que `await` no renderer veja os
   microtasks do handler já executados (`:308-323`).
3. Resultado não clonável não derruba o processo: vira `{error}` (`:262-278`).
4. `sendSync` sem listener apenas emite warning, não erro (`:650-656`).

Não há compactação de contexto, cancelamento, retry ou orçamento de tokens; isso é
responsabilidade do app. Para streaming de ferramentas, o padrão do Electron é
emitir eventos e usar `MessageChannelMain`/`utilityProcess`, não um canal
bidirecional nativo.

## 6. Sessões, estado e persistência

- `session` é a unidade de isolamento: partição persistente ou em memória, cookies,
  cache, storage e permissões. A sessão é obtida por `fromPartition`/`fromPath`
  (`lib/browser/api/session.ts:6`) e a partição vazia devolve a sessão padrão
  (`session.ts:126`).
- Cookies em disco são SQLite; a fuse `cookieEncryption` criptografa com chave do
  SO, mas é transição de mão única (`docs/tutorial/fuses.md:38-54`).
- `safeStorage` usa DPAPI no Windows, Keychain no macOS e libsecret no Linux
  (`lib/browser/api/safe-storage.ts:1`).
- Não há store de sessão de app, checkpoint ou retomada no runtime (não encontrado em `lib/browser`); isso é padrão do app.
  O Electron só fornece `session` e `webContents` lifecycle.
- `BrowserView` foi substituído por `WebContentsView`; o antigo é compatibilidade
  (`lib/browser/api/browser-view.ts:12-46`).

## 7. Configuração e extensibilidade

- `webPreferences` por janela: `contextIsolation`, `sandbox`, `nodeIntegration`,
  `webSecurity`, `allowRunningInsecureContent`, `preload`, `partition`
  (`default_app/default_app.ts:87-99`; `src/main/index.ts:505-518` no nosso app).
- Fuses de build: `runAsNode`, `nodeOptions`, `nodeCliInspect`,
  `embeddedAsarIntegrityValidation`, `onlyLoadAppFromAsar`, `cookieEncryption`
  (`docs/tutorial/fuses.md:24-123`). São bits no binário, não config de runtime.
- `app.commandLine.appendSwitch` para flags do Chromium; `--inspect` é controlado
  pela fuse `nodeCliInspect` (`fuses.md:68-76`).
- Extensões de terceiros não são um sistema do Electron; quem implementa é o app
  (preload + protocol + permissões). Não há plugin registry no núcleo.
- `protocol.registerSchemesAsPrivileged` precisa ser chamado antes de `app.ready`
  (`lib/browser/api/protocol.ts:260-278`).

## 8. Permissões, sandbox e erros

O próprio repositório mantém um checklist de 20 itens (`docs/tutorial/security.md:96-120`).
Os que mais importam para o Openclod:

| Regra | Evidência | Situação no nosso app |
|---|---|---|
| Validar `sender`/`senderFrame` de **todo** IPC | `security.md:743-778` | validamos só `event.sender.id`, não a origem do frame (`src/main/index.ts:428-449`) |
| Não usar `file://`; servir de protocolo customizado | `security.md:780-799` | produção usa `loadFile` (`src/main/index.ts:581`) |
| Context isolation + sandbox + sem Node no renderer | `security.md:223-270` | OK (`src/main/index.ts:507-510`) |
| Limitar navegação e novas janelas | `security.md:593-685` | OK (`src/main/index.ts:539-552`) |
| Verificar opções de `<webview>` antes de anexar | `security.md:547-591` | OK, com partição e allow-list (`src/main/index.ts:522-535`) |
| CSP forte | `security.md:355-413` | `script-src 'self' 'unsafe-inline'` (`src/renderer/index.html:5-7`) |
| Fuses e integridade do asar | `fuses.md:78-123` | não configuradas (`electron-builder.yml:1-66`) |
| Não expor API do Electron a conteúdo não confiável | `security.md:823-850` | preload expõe só `openclod` (`src/preload/index.ts:214`) |

O sandbox é desabilitado automaticamente quando `nodeIntegration` está ligado
(`docs/tutorial/sandbox.md:18-34, 98`). Em renderer sandboxed, o preload não tem
`Buffer`, `process` completo nem módulos Node (`sandbox.md:48-70`). Erros de IPC
são logados no main e devolvidos ao renderer como `{error}`; não há crash do
processo por resultado não clonável (`electron_api_ipc_dispatch.cc:225-278`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Specs de API | `spec/api-*.spec.ts` (92 arquivos) | BrowserWindow, IPC, contextBridge, protocol, session |
| Segurança | `spec/security-warnings.spec.ts:22-190` | Node integration remoto, `webSecurity`, CSP, `allowpopups`, recursos inseguros |
| IPC | `spec/api-ipc.spec.ts:23-223` | handler sync/async, thenable, erro, clone, handler duplicado, payload > limiar de shared memory |
| Context bridge | `spec/api-context-bridge.spec.ts:1` | exposição e isolamento |
| Runner | `spec/vitest/*` | pool de processos, serialização, timings |
| Smoke de tipos | `spec/ts-smoke/runner.js` | definições TypeScript geradas |

A qualidade é alta, mas o custo de manter um fork é proibitivo: o valor está nas
**decisões de segurança e no formato de IPC**, não no código.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Guarda de IPC por frame/origem, além do `webContents.id` | `docs/tutorial/security.md:743-778`; `electron_api_ipc_dispatch.cc:661-692` | fecha o buraco de iframe/webview que compartilha o mesmo `sender.id` | MIT | `src/main/security/ipc.ts` | 22 |
| Fuses de produção + integridade do asar | `docs/tutorial/fuses.md:78-123` | impede `ELECTRON_RUN_AS_NODE`, `--inspect` e troca de `app.asar` | MIT | `electron-builder.yml` + `scripts/after-pack.cjs` | 20 |
| Protocolo `app://` em vez de `file://` | `docs/tutorial/security.md:780-799`; `lib/browser/api/protocol.ts:154-188` | tira o poder de leitura arbitrária de arquivo de uma XSS | MIT | `src/main/protocol/app.ts` | 19 |
| `WebContentsView` no lugar de `<webview>` para o preview | `lib/browser/api/browser-view.ts:12-46` | view no processo main, sem tag HTML e com ciclo de vida explícito | MIT | `src/main/browser/view.ts` | 18 |
| CSP com nonce/hash gerado no build | `docs/tutorial/security.md:355-413` | remove `unsafe-inline` sem quebrar o bundle | MIT | `src/main/security/csp.ts` | 16 |
| `utilityProcess` para STT/OCR/embedding | `lib/browser/api/utility-process.ts:93-110` | isola CPU/memória e evita travar o main | MIT | `src/main/workers/` | 15 |
| Permissões por sessão (preview vs. main) | `docs/tutorial/security.md:272-310` | o main libera clipboard/fullscreen para qualquer `contents`; só áudio é restrito ao main (`src/main/index.ts:1635-1648`) | MIT | `src/main/security/permissions.ts` | 17 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| C++ de `shell/browser` (IPC, janela, permissões) | stack incompatível; já usamos o binário oficial |
| Build GN/Ninja e patches do Chromium | só faz sentido para manter um fork do Electron |
| `BrowserView` | depreciado; `WebContentsView` é o substituto |
| App padrão (`default_app/`) | é demo, não arquitetura de produto |
| Checklists de docs como código | são guias; precisam virar teste no nosso repositório |
| `webviewTag: true` como padrão | aumenta a superfície; preferir view no main |
| `shell.openExternal` direto com URL de página | `security.md:686-714`; validar protocolo e host antes |
| Faixa de abas/explorer de arquivos | não são do runtime (não encontrado); cada app implementa |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto, sem copiar código:

1. **Um único registro de canais** em `src/main/security/ipc.ts`:
   `{ channel, schema, handler, frames: 'main-only' | 'preview', rateLimit }`.
   O wrapper substitui o `handle()` atual (`src/main/index.ts:435-449`) e valida:
   `event.senderFrame.origin`, `event.sender.id`, `event.senderFrame.parent === null`
   para canais privilegiados, e o schema Zod antes de chamar o handler.
2. **Janela com política explícita** em `src/main/window-factory.ts`:
   `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`,
   `webSecurity: true`, `webviewTag: false`, `setWindowOpenHandler` deny,
   `will-navigate` deny fora do app, `setPermissionRequestHandler` allow-list.
3. **Protocolo `app://`** em `src/main/protocol/app.ts`, registrado como
   `standard`, `secure`, `supportFetchAPI`, `corsEnabled`, servindo apenas
   `out/renderer/**` com `path.resolve` + prefixo. Em dev, manter
   `ELECTRON_RENDERER_URL`.
4. **Fuses** via `@electron/fuses` no `afterPack`: `RunAsNode: false`,
   `EnableNodeOptionsEnvironmentVariable: false`,
   `EnableNodeCliInspectArguments: false`,
   `EnableEmbeddedAsarIntegrityValidation: true`, `OnlyLoadAppFromAsar: true`.
5. **CSP** gerada no build: hash do script inline ou nonce; `script-src 'self'`,
   `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`.
6. **Teste de contrato**: um spec que abre a janela, tenta `invoke` de um iframe
   `data:` e espera `origem não autorizada`; outro que verifica que
   `window.require` e `process` não existem no renderer.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/desktop-ui/electron--electron rev-parse HEAD
96a2dc1f28a4e4a32fdc19d54ba0af36c7f2c536

$ sed -n '87,101p' default_app/default_app.ts
webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false }
mainWindow = new BrowserWindow(options)

$ sed -n '15,23p' lib/browser/ipc-main-impl.ts
handle = (method, fn) => { if (this._invokeHandlers.has(method)) throw ... }

$ sed -n '403,469p' shell/browser/api/electron_api_ipc_dispatch.cc
RunInvokeHandler(...)  // handler(event, ...args), await result, reply

$ sed -n '743,778p' docs/tutorial/security.md
"Validate the sender of all IPC messages" / frame.origin allowlist

$ sed -n '780,799p' docs/tutorial/security.md
"Avoid usage of the file:// protocol and prefer usage of custom protocols"

$ sed -n '78,105p' docs/tutorial/fuses.md
embeddedAsarIntegrityValidation / onlyLoadAppFromAsar

$ grep -n "loadFile" src/main/index.ts
581: void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))

$ grep -n "trustedSender" src/main/index.ts
428: function trustedSender(event: { sender: { id: number } }): boolean {
429:   return Boolean(mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id)
```

Limitações: não executei o build nem os specs do Electron; a análise é estática.
O clone é a linha `main` de desenvolvimento, não uma release estável.
