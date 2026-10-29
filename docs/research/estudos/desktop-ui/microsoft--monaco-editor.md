# Monaco Editor

| Campo | Valor |
|---|---|
| Repositório | https://github.com/microsoft/monaco-editor |
| Clone local | `repositorios/_research/desktop-ui/microsoft--monaco-editor` |
| Commit | `dbf1945df2ff7e46512d2f548cc5c0977a3eadd8` |
| Licença | MIT (`LICENSE.txt:1-8`) |
| Categoria | desktop-ui (editor de código) |
| Stack | TypeScript, ESM/AMD, Rollup/esbuild, Playwright, npm (`package.json:1-90`) |
| Tamanho | 995 arquivos; ~401 mil linhas (`.js` ~207 mil, `.ts` ~132 mil), 82 definições de linguagem |

## 1. O que é (verificado no código)

É a distribuição do editor do VS Code para a web. **Neste commit, o núcleo do
editor não está no repositório**: `src/` contém o registro de features
(`src/features/*/register.js`), as definições de linguagem e o bootstrap de
workers (`src/internal/common/workers.ts`); o código real vem do pacote npm
`monaco-editor-core@0.57.0-rc.2` (`package.json:73`). Cada
`register.js` é uma linha importando um módulo do core, por exemplo
`src/features/codeEditor/register.js:1` e `src/features/diffEditor/register.js:1`.

O README diz que o Monaco é “the fully featured code editor from VS Code”
(`README.md:8`), mas isso é verdade histórica: o que este repo publica é um
**shell de features + languages + LSP client** em volta do core. O build
`build/build-monaco-editor.ts:14-55` copia licenças, tipos e metadados do
`node_modules/monaco-editor-core`, confirmando a separação.

O valor para o Openclod está em três lugares: (a) o registro de features mostra
como compor um editor grande sem carregar tudo; (b) o `monaco-lsp-client` tem uma
ponte LSP tipada, com sincronização de modelos e capabilities; (c) o sample
`electron-esm-webpack` mostra **como não** embutir no Electron.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `npm run build` | `package.json:33` | build do LSP + build do Monaco |
| `npm run build-monaco-editor` | `package.json:34` | Rollup ESM/AMD, copia tipos e licenças |
| `npm run build-lsp` | `package.json:35` | instala e builda `monaco-lsp-client` |
| `npm run build-all` | `package.json:32` | LSP + editor + smoke de packaging |
| `npm test` | `package.json:26` | checa samples e roda testes de gramática |
| `npm run smoketest` | `package.json:22` | Playwright nos pacotes webpack/esbuild/vite |
| `npm run simpleserver` | `package.json:16` | servidor local para samples |
| `npm run package-for-smoketest` | `package.json:17` | empacota os três bundlers |

A superfície de UX é a API `monaco.editor`: `create`, `createModel`,
`createDiffEditor`, `setModel`, `registerCompletionItemProvider`,
`setModelMarkers`, `createWebWorker`. O playground e os 12 samples
(`samples/`) são a documentação executável.

## 3. Arquitetura e fluxo

```text
monaco-editor (este repo)
  → src/features/register.all.ts (importa 64 register.js)
  → cada register.js importa monaco-editor-core/esm/...
  → monaco-editor-core (editor, model, view, diff, workers)
  → MonacoEnvironment.getWorkerUrl(label) → json/css/html/ts/editor worker
  → opcional: monaco-lsp-client (JSON-RPC) → language server
```

- Entry point de features: `src/features/register.all.ts:1-64`; o pacote exporta
  `editor.main.js` (`package.json:37-47`).
- Core: dependência externa `monaco-editor-core` (`package.json:73`), copiada no
  build (`build/build-monaco-editor.ts:14-55`).
- Workers: o app define `self.MonacoEnvironment.getWorkerUrl(moduleId, label)` e
  devolve o bundle por linguagem (`samples/electron-esm-webpack/index.js:3-18`;
  `docs/integrate-esm.md:70-110`).
- Diff: a feature é registrada por `src/features/diffEditor/register.js:1`, mas a
  implementação do algoritmo **não está neste clone**; o único exemplo é
  `test/manual/diff.js:1-12` (`createDiffEditor` + `setModel`).
- LSP: `monaco-lsp-client/src/adapters/LspClient.ts:30-59` cria o cliente,
  inicializa com capabilities e guarda as capabilities do servidor;
  `TextDocumentSynchronizer.ts:7-120` mantém o mapa modelo↔URI e envia
  `didOpen`/`didChange`.
- Streaming: não há; o editor é síncrono. O LSP usa JSON-RPC tipado
  (`@hediet/json-rpc`, `monaco-lsp-client/package.json:8-12`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Registro de features | `src/features/register.all.ts:1-64` | liga/desliga 64 features por import | baixo |
| `codeEditor` | `src/features/codeEditor/register.js:1` | editor base | baixo |
| `diffEditor` | `src/features/diffEditor/register.js:1` | diff lado a lado/inline | baixo |
| `gpu` | `src/features/gpu/register.js:1` | renderer GPU (feature nova) | médio |
| `inlineCompletions` | `src/features/inlineCompletions/register.js:1` | ghost text de IA | alto (conteúdo do modelo) |
| `codeAction` | `src/features/codeAction/register.js:1` | quick fixes | médio |
| `semanticTokens` | `src/features/semanticTokens/register.js:1` | highlighting por LSP | baixo |
| `MonacoLspClient` | `monaco-lsp-client/src/adapters/LspClient.ts:30-59` | handshake e capabilities | médio |
| `TextDocumentSynchronizer` | `.../TextDocumentSynchronizer.ts:7-120` | didOpen/didChange por modelo | médio |
| 23 adapters LSP | `monaco-lsp-client/src/adapters/languageFeatures/*` | completion, hover, rename, diagnóstico etc. | médio |
| 82 linguagens | `src/languages/definitions/` | grammars e contribuições | baixo (tamanho) |
| `MonacoEnvironment` | `samples/electron-esm-webpack/index.js:3-18` | resolve URL dos workers | alto se mal configurado |

As features são **opt-in por import**: quem importa `register.all.ts` paga tudo;
quem importa só `codeEditor` + `diffEditor` paga menos. O repo não tem um
manifesto de tamanho por feature; o `samples/browser-esm-webpack-small` é a
referência de build mínimo.

## 5. Loop do agente, contexto e streaming

Não há loop de agente. O que existe é o ciclo do **LSP**:

1. `MonacoLspClient` inicializa o servidor e registra capabilities
   (`LspClient.ts:30-59`).
2. `TextDocumentSynchronizer` cria um `ManagedModel` por `ITextModel`, envia
   `textDocument/didOpen` com `languageId`, `uri`, `version` e `text`
   (`TextDocumentSynchronizer.ts:122-141`).
3. Em `onDidChangeContent`, envia `didChange` com as mudanças e incrementa a
   versão; em `onWillDispose`, fecha o documento (`:140-170`).
4. As features traduzem posições 1-based do Monaco para 0-based do LSP
   (`TextDocumentSynchronizer.ts:71-119`) e registram providers
   (`LspCompletionFeature.ts:44-82`).
5. Diagnósticos viram `monaco.editor.setModelMarkers`
   (`LspDiagnosticsFeature.ts:82-97`); o modelo descartado é ignorado
   (`:89-99`).

O `CancellationToken` do Monaco é passado ao provider
(`LspCompletionFeature.ts:78-82`), mas o cliente não cancela a request JSON-RPC
no servidor; não encontrei `$/cancelRequest` no clone. Também não há retry,
backoff ou compactação de contexto — é um bridge de editor, não um agente.

## 6. Sessões, estado e persistência

- Modelos são identificados por URI; `createModel` sem URI vira
  `inmemory://model/N` (`README.md:44-50`). Não há store em disco.
- O modelo guarda texto, linguagem, versão e undo; o editor guarda view state
  (scroll, seleção, folding) por editor, não por modelo.
- `TextDocumentSynchronizer` mantém dois mapas em memória
  (`model → ManagedModel` e `uri → model`), limpos em `onWillDispose`
  (`TextDocumentSynchronizer.ts:8-9`, `:63-67`). Não há persistência de sessão.
- O Monaco não tem “workspace”; quem monta o workspace é o app. O sample Electron
  só cria um modelo e um editor (`samples/electron-esm-webpack/index.js:21-25`).

## 7. Configuração e extensibilidade

- Features por import (`src/features/register.all.ts`), languages por
  contribuição (`src/languages/definitions/*/monaco.contribution.ts`).
- Workers por `MonacoEnvironment.getWorkerUrl` (`docs/integrate-esm.md:70-110`);
  sem isso, o editor tenta carregar workers por URL relativa e falha em bundlers.
- LSP client é um pacote separado (`monaco-lsp-client/package.json:1-20`) com
  generator de tipos (`generator/index.ts`) e build Rolldown.
- Tema, `automaticLayout`, `readOnly`, `fontSize` etc. são opções de
  `monaco.editor.create`; não há arquivo de config padrão no repo.
- `monaco-editor-core` é peer dependency do LSP client
  (`monaco-lsp-client/package.json:14-16`); a versão precisa casar.

## 8. Permissões, sandbox e erros

O Monaco em si não acessa SO, rede ou filesystem; o risco está no **sample
Electron**, que é inseguro:

| Problema no sample | Evidência | Por que importa |
|---|---|---|
| `loadURL('file://...')` | `samples/electron-esm-webpack/main.js:13` | `file://` dá acesso amplo a arquivos; Electron recomenda protocolo customizado |
| `worldSafeExecuteJavaScript` (obsoleto) | `samples/electron-esm-webpack/main.js:11` | não é `contextIsolation`/`sandbox`; não protege o renderer |
| Sem `contextIsolation`, `sandbox`, `nodeIntegration: false` | `samples/electron-esm-webpack/main.js:8-13` | padrão antigo do Electron; hoje é inseguro |
| `openDevTools()` sempre | `samples/electron-esm-webpack/main.js:14` | não é produção |
| CSP não definida | sample não tem `<meta>` | workers e `eval` do AMD podem exigir relaxamento |

O editor trata o conteúdo como **texto**, não executa HTML; a renderização de
markdown/hover é feita por componentes do core. O risco real é o app permitir
`inlineCompletions` de um provider remoto sem revisão e abrir links do hover sem
allow-list.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Smoke Playwright | `test/smoke/smoke.test.ts:17-100` | API global, editor plaintext, CSS/HTML/JSON/TS |
| Gramáticas | `src/languages/definitions/*/*.test.ts` | tokenização das 82 linguagens |
| Samples | `build/check-samples.ts` | builds webpack/esbuild/vite/parcel |
| Manual diff | `test/manual/diff.js` | diff lado a lado (não automatizado) |
| Core | **não encontrado** | o núcleo está no pacote `monaco-editor-core`, fora do clone |

A suíte do repo é de **empacotamento e integração**, não de comportamento do
editor. Os testes pesados do core ficam no VS Code, não aqui. Isso reduz muito o
valor de portar código: não teríamos a rede de segurança.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Ponte LSP tipada com sync de modelo e capabilities | `monaco-lsp-client/src/adapters/TextDocumentSynchronizer.ts:7-170`; `LspClient.ts:30-59` | nosso `code-intelligence` é heurística estática; um LSP real dá hover/definição/rename | MIT | `src/core/lsp/bridge.ts` | 19 |
| Modelo de features opt-in por import | `src/features/register.all.ts:1-64` | evita carregar 50 features no bundle | MIT | `src/renderer/src/editor/features.ts` | 14 |
| Workers separados por linguagem | `docs/integrate-esm.md:70-110` | tira parse de TS/JSON do renderer | MIT | `src/renderer/src/editor/workers.ts` | 15 |
| Diagnósticos → markers com owner e dispose | `LspDiagnosticsFeature.ts:82-97` | padrão limpo para mostrar erros de typecheck no editor | MIT | `FilesPane` (markers) | 16 |
| API de diff (`createDiffEditor`/`setModel`) | `test/manual/diff.js:1-12` | modelo de dois modelos + editor, útil para revisão | MIT | referência para `ChangesPane` | 12 |
| Sample Electron | `samples/electron-esm-webpack/main.js:8-14` | **negativo**: mostra o que não fazer | MIT | não copiar | 3 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Trocar CodeMirror por Monaco | nosso editor é leve, já integrado e cobre as linguagens que usamos; Monaco adiciona ~5 MB e workers |
| `monaco-editor-core` como dependência | bundle grande + versão `rc`; não precisamos do editor inteiro |
| 82 definições de linguagem | peso morto; carregar sob demanda se um dia precisarmos |
| Build AMD | o próprio README diz que é legado e será removido (`README.md:29`) |
| Samples (webpack/parcel/nwjs) | são demos de packaging, não arquitetura |
| LSP client como está | 0.1.0, sem cancelamento `$/cancelRequest`, sem testes próprios; usar `@codemirror/lsp-client` ou implementar o subconjunto |
| Feature `gpu` | experimental; não há necessidade no nosso editor |
| Abas/explorer de arquivos | não são conceitos do Monaco (não encontrado); o host gerencia modelos e views |

## 12. Modelo de exemplo para o nosso harness

Se um dia precisarmos de um editor “pesado”, o desenho seria:

1. **Modelo por arquivo** com URI `file:///<root>/<path>` e versão incremental;
   um `Map<uri, { model, version }>` no renderer, espelhando o padrão do
   `TextDocumentSynchronizer`.
2. **LSP no main**, não no renderer: o `src/core/lsp/session.ts` sobe o servidor
   com `child_process.spawn`, framing `Content-Length`, timeout por request,
   `shutdown`/`exit` e kill de árvore. O renderer só troca mensagens.
3. **Workers** para o que for intensivo (parse de TS/JSON), com URL explícita e
   CSP `worker-src 'self' blob:`.
4. **Diagnósticos** com owner estável (`openclod-lsp`) e `setModelMarkers`; limpar
   no `onWillDispose`.
5. **Diff** com dois modelos e um editor somente-leitura; o “aceitar” aplica um
   `WorkspaceEdit` no modelo original, não no texto renderizado.
6. **Teste**: um workspace de fixture com `tsconfig` e um erro de tipo; abrir o
   arquivo, esperar marker na linha certa, renomear um símbolo e verificar que
   todos os arquivos foram atualizados.

Recomendação: **não trocar o CodeMirror**. O caminho barato é usar
`@codemirror/lsp-client` (o repo CodeMirror lista esse pacote) e manter o Monaco
como referência de UX.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/desktop-ui/microsoft--monaco-editor rev-parse HEAD
dbf1945df2ff7e46512d2f548cc5c0977a3eadd8

$ sed -n '1,10p' package.json
"name": "monaco-editor", "version": "0.57.0", "vscodeRef": "6a598d4a..."

$ grep -n "monaco-editor-core" package.json
59: "monaco-editor-core": "0.57.0-rc.2"

$ cat src/features/codeEditor/register.js
import 'monaco-editor-core/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget';

$ sed -n '14,55p' build/build-monaco-editor.ts
buildESM(); buildAmdMinDev(); readFiles('node_modules/monaco-editor-core/LICENSE'...)

$ sed -n '7,120p' monaco-lsp-client/src/adapters/TextDocumentSynchronizer.ts
ManagedModel(...) → textDocumentDidOpen({ languageId, uri, version, text })

$ sed -n '8,14p' samples/electron-esm-webpack/main.js
new BrowserWindow({ webPreferences: { worldSafeExecuteJavaScript: true } })
mainWindow.loadURL(`file://${__dirname}/dist/electron-index.html`)

$ find src/languages/definitions -maxdepth 1 -type d | wc -l
82
```

Limitações: não rodei build, smoke tests nem o playground. O núcleo do editor
não está no clone; qualquer afirmação sobre algoritmo de diff, tokenização ou
render fica fora deste estudo.
