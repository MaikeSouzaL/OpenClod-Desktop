# xterm.js

| Campo | Valor |
|---|---|
| Repositório | https://github.com/xtermjs/xterm.js |
| Clone local | `repositorios/_research/desktop-ui/xtermjs--xterm.js` |
| Commit | `991857a1b1cacf06f9531ba74a6e927a7a6398bb` |
| Licença | MIT (`LICENSE:1-6`) |
| Categoria | desktop-ui (terminal) |
| Stack | TypeScript (tsgo/native preview), webpack/esbuild, Mocha + Playwright, oxlint; npm (`package.json:1-40`) |
| Tamanho | 760 arquivos; ~97 mil linhas (`.ts` ~82 mil), 13 addons |

## 1. O que é (verificado no código)

É um **emulador de terminal completo no navegador**: parser de escape sequences,
buffer de linhas com scrollback, seleção, mouse tracking, links, acessibilidade e
dois renderers (DOM e WebGL). Não é um PTY e não fala com processo nenhum; o app
fornece bytes e recebe `onData`. A versão deste clone é `6.0.0`
(`package.json:4`), a mesma faixa que o Openclod já usa (`@xterm/xterm ^6.0.0`).

O entrypoint público é `src/browser/public/Terminal.ts:25`, que delega para
`TerminalCore` e, no browser, para `CoreBrowserTerminal`. O core é compartilhado
com a distribuição headless (`src/common/CoreTerminal.ts`), mas o clone **não
contém** `headless/` implementado: só `headless/package.json` e README.

O terminal é dividido em três camadas: `common` (parser, buffer, input, serviços),
`browser` (DOM, renderer, seleção, acessibilidade) e `addons` (13 pacotes
independentes). O nosso `TerminalPane.tsx` já usa `@xterm/xterm` + `addon-fit`
(`src/renderer/src/components/TerminalPane.tsx:2-4`), então o estudo é sobre
**quais addons e padrões adicionar**, não sobre trocar de terminal.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `npm run setup` | `package.json:34` | build + esbuild do demo |
| `npm start` | `package.json:37` | demo com PTY real via WebSocket (`demo/start`) |
| `npm run dev` | `package.json:38` | tsc/esbuild/demo em watch |
| `npm run build` | `package.json:39` | `tsgo -b tsconfig.all.json` |
| `npm run test` | `package.json:52` | testes unitários (Mocha) |
| `npm run test-integration` | `package.json:62` | Playwright em Chromium/Firefox/WebKit |
| `npm run benchmark` | `package.json:67` | benchmark de parser/render |
| `npm run lint` | `package.json:54` | oxlint type-aware + naming |
| `npm run vtfeatures` | `package.json:71` | extrai a matriz de sequências VT suportadas |

A superfície de UX é a API `Terminal`: `open`, `write`, `resize`, `onData`,
`onResize`, `onRender`, `loadAddon`, `registerLinkProvider`, `parser`,
`buffer`, `options` (`src/browser/public/Terminal.ts:71-120`). As opções
constructor-only são `cols`/`rows` (`Terminal.ts:21`, `:57-62`); APIs “proposed”
exigem `allowProposedApi: true` (`Terminal.ts:66-68`).

## 3. Arquitetura e fluxo

```text
app/PTY → terminal.write(bytes)
  → WriteBuffer (chunks, orçamento de 12 ms, watermark 50 MB)
  → InputHandler.parse → EscapeSequenceParser / OscParser
  → BufferService (BufferSet + scrollback)
  → RenderService.refreshRows(start,end)
  → RenderDebouncer (rAF) → DOM Renderer | WebglRenderer
  → onData (tecla/cola) → app escreve no PTY
```

- Entrada: `Terminal.write` em `src/browser/public/Terminal.ts:224-226`; o
  buffer de escrita fica em `CoreTerminal` (`src/common/CoreTerminal.ts:158-163`).
- Backpressure de parse: `WriteBuffer` tem `DISCARD_WATERMARK = 50_000_000`
  (~50 MB), `WRITE_TIMEOUT_MS = 12` e `WRITE_BUFFER_LENGTH_THRESHOLD = 50`
  (`src/common/input/WriteBuffer.ts:11-33`). É uma proteção contra crash do
  navegador, não um fluxo de crédito.
- Parser: `InputHandler.parse` usa `EscapeSequenceParser` e `OscParser`
  (`src/common/InputHandler.ts:159-185`); o buffer máximo de parse é 131.072
  (`InputHandler.ts:45`).
- Buffer/scrollback: `Buffer.resize` recalcula `rows + scrollback`
  (`src/common/buffer/Buffer.ts:119-125`, `:165-247`).
- Render: `RenderService` cria o `RenderDebouncer` e agenda `refreshRows`
  (`src/browser/services/RenderService.ts:74`, `:156-180`); a troca de renderer
  é `setRenderer` (`:247-253`).
- Browser: `CoreBrowserTerminal.open` cria `RenderService` e o renderer inicial
  (`src/browser/CoreBrowserTerminal.ts:536-580`).
- Saída de input: `term.onData` → `window.forja.terminal.write` no nosso app
  (`src/renderer/src/components/TerminalPane.tsx:76`).
- Resize: `FitAddon.fit()` calcula dimensões e chama `terminal.resize`
  (`addons/addon-fit/src/FitAddon.ts:55-90`), que dispara `onResize` →
  `terminal.resize` do PTY (`TerminalPane.tsx:77`).

## 4. Catálogo de ferramentas / capacidades

| Addon / capacidade | Versão | Arquivo:linha | O que faz | Risco |
|---|---:|---|---|---|
| `addon-fit` | 0.11.0 | `addons/addon-fit/src/FitAddon.ts:55` | calcula cols/rows pelo container | baixo |
| `addon-webgl` | 0.19.0 | `addons/addon-webgl/src/WebglAddon.ts:51-84` | renderer GPU com atlas de glifos | médio (context loss) |
| `addon-search` | 0.16.0 | `addons/addon-search/src/SearchAddon.ts:33-167` | busca, seleção e decorações | baixo |
| `addon-serialize` | 0.14.0 | `addons/addon-serialize/src/SerializeAddon.ts:1-90` | serializa buffer/células em ANSI/HTML | médio (tamanho) |
| `addon-unicode-graphemes` | 0.4.0 | `addons/addon-unicode-graphemes/src` | largura de grafemas/emoji | baixo |
| `addon-web-links` | 0.12.0 | `addons/addon-web-links/src/WebLinksAddon.ts:24-56` | links http(s) clicáveis | alto (abrir URL) |
| `addon-ligatures` | 0.10.0 | `addons/addon-ligatures/src` | ligaduras de fonte | baixo |
| `addon-web-fonts` | 0.1.0 | `addons/addon-web-fonts/src` | carrega webfonts | baixo |
| `addon-clipboard` | 0.2.0 | `addons/addon-clipboard/src` | OSC 52 (clipboard) | alto (exfiltração) |
| `addon-image` | 0.9.0 | `addons/addon-image/src` | imagens no terminal (sixel/iTerm) | médio (memória) |
| `addon-attach` | 0.12.0 | `addons/addon-attach/src` | WebSocket attach | alto (transporte) |
| `addon-progress` | 0.2.0 | `addons/addon-progress/src` | progresso OSC 9;4 | baixo |
| `OscLinkProvider` | core | `src/browser/OscLinkProvider.ts:12-60` | links OSC 8 | alto (URL arbitrária) |

O renderer DOM é o padrão; o WebGL é opt-in e tem fallback em perda de contexto
(`WebglAddon.ts:27-28`, `:84`). A acessibilidade usa uma `aria-live` “assertive”
com debounce e limite de linhas (`src/browser/AccessibilityManager.ts:83-87`,
`:142-156`).

## 5. Loop do agente, contexto e streaming

Não há agente. O que existe é um **pipeline de bytes** com três mecanismos de
proteção:

1. **Chunking**: `WriteBuffer` acumula chunks e processa até 12 ms por vez,
   devolvendo o controle ao renderer com `setTimeout(0)` quando estoura
   (`WriteBuffer.ts:20-33`). Isso mantém ~30–60 fps sob flood.
2. **Watermark**: se `_pendingData` passa de 50 MB, `write()` **lança**
   `write data discarded, use flow control to avoid losing data` e o lote não é
   aceito (`WriteBuffer.ts:156-158`). O comentário chama o limite de “safety
   parachute” (`:11-20`). Não há ack para o produtor; o PTY continua escrevendo.
3. **Parse**: `InputHandler` processa bytes e emite eventos; `onWriteParsed`
   sinaliza que o lote terminou (`CoreTerminal.ts:158-163`).

O xterm **não implementa flow control de PTY**. Quem escreve no PTY é o app; se o
main process despejar 100 MB, o xterm vai parsear e descartar, mas o processo
continua produzindo. Nosso `TerminalManager` faz flush a cada 12 ms e guarda
200 mil caracteres (`src/main/terminal.ts:9-12`, `:110-116`), sem crédito nem
ack — exatamente o ponto que o Terax resolve com janela de 1 MiB e ACK cumulativo.

## 6. Sessões, estado e persistência

- O xterm não persiste nada. Buffer e scrollback vivem em memória; `dispose()`
  libera tudo (`src/browser/public/Terminal.ts:200-205`).
- `addon-serialize` é o único caminho suportado para “salvar” a tela: ele
  percorre as células e emite ANSI/HTML (`SerializeAddon.ts:1-90`). É mais
  correto que replay de bytes brutos, porque normaliza atributos e não reexecuta
  sequências perigosas.
- O nosso app guarda os últimos 200.000 caracteres **crus** no main
  (`src/main/terminal.ts:9`, `:110-116`) e repinta com `term.write(snapshot)`
  (`TerminalPane.tsx:69-74`). Isso funciona, mas reparseia escapes e pode
  reexecutar OSC 52/links.
- Não há fork, checkpoint ou retomada de sessão de terminal (não encontrado no pacote).

## 7. Configuração e extensibilidade

- Opções: `fontFamily`, `fontSize`, `lineHeight`, `cursorBlink`, `scrollback`,
  `theme`, `rightClickSelectsWord`, `macOptionIsMeta`, `windowsPty`,
  `allowProposedApi` (`src/common/Types.ts:39-150`; `src/browser/public/Terminal.ts:40-68`).
- Addons são carregados por `loadAddon`; cada um implementa `ITerminalAddon`
  (`activate`/`dispose`), padrão descrito em `AGENTS.md` do repo (dado, não
  instrução para nós).
- `parser.registerCsiHandler`/`registerOscHandler` permitem tratar sequências
  próprias (`src/common/InputHandler.ts:159-185`).
- `linkHandler` é a opção para interceptar links OSC 8 sem usar o addon
  (`src/browser/OscLinkProvider.ts:29-31`).
- Tema é um mapa de cores; o nosso `xtermTheme()` lê CSS variables
  (`TerminalPane.tsx:21-30`), o que é uma boa adaptação ao tema do app.

## 8. Permissões, sandbox e erros

O xterm não executa comandos nem acessa o SO; o risco está no que o **conteúdo**
do terminal pode pedir ao host:

| Vetor | Evidência | Mitigação |
|---|---|---|
| OSC 8 hyperlink para `javascript:`/`file:` | `OscLinkProvider.ts:58-70` | validar `http(s)` antes de abrir; nunca `shell.openExternal` direto |
| OSC 52 clipboard | `addons/addon-clipboard/src` | desabilitar por padrão ou exigir confirmação |
| `window.open` do web-links | `addons/addon-web-links/src/WebLinksAddon.ts:24-34` | no Electron, `setWindowOpenHandler` já bloqueia; usar handler IPC |
| Imagens sixel/iTerm | `addons/addon-image/src` | limitar pixels e memória |
| APIs propostas | `Terminal.ts:66-68` | manter `allowProposedApi: false` |
| Context loss do WebGL | `WebglAddon.ts:27-28` | ouvir `onContextLoss` e cair para DOM |

O xterm **não sanitiza** o texto; ele desenha o que o processo mandar. A defesa
é do host: não interpretar output como HTML, não abrir links sem allow-list e
não permitir que o terminal dispare IPC privilegiado.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Unit (Mocha) | `src/**/*.test.ts` (57 arquivos) | buffer, parser, input, linkifier, seleção, tema |
| Addons | `addons/**/*.test.ts` (32 arquivos) | fit, search, serialize, webgl, image, unicode |
| Integração | `test/playwright/*.test.ts` (6 suítes) | input, mouse, parser, renderer, char width, terminal |
| Headless | `headless/` | só metadados neste clone; implementação ausente |
| Benchmark | `test/benchmark/` | parser e render |

O projeto tem um `AGENTS.md` com convenções (project references, `MutableDisposable`,
`const enum`, testes ao lado do fonte). A suíte é grande e cobre bordas de VT;
o ponto fraco é que o renderer WebGL depende de GPU real e os testes de
integração rodam em navegadores, não no Electron.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Renderer WebGL com fallback | `addons/addon-webgl/src/WebglAddon.ts:51-84` | reduz CPU e melhora scroll em output denso; já estamos na mesma versão 6.0.0 | MIT | `src/renderer/src/components/terminal/webgl.ts` | 23 |
| Busca com decorações e resultados | `addons/addon-search/src/SearchAddon.ts:33-167` | não temos busca no terminal; o addon já resolve highlight/scroll | MIT | `src/renderer/src/components/terminal/search.ts` | 21 |
| Snapshot serializado em vez de bytes brutos | `addons/addon-serialize/src/SerializeAddon.ts:1-90` | evita reparse de escapes e reduz o buffer de 200k chars | MIT | `src/main/terminal.ts` (snapshot) | 20 |
| Largura de grafemas/emoji | `addons/addon-unicode-graphemes/src` | evita desalinhamento com emoji/CJK, comum em output de agentes | MIT | `TerminalView` (addon) | 19 |
| Links OSC 8 com handler seguro | `src/browser/OscLinkProvider.ts:12-60` | permite abrir links do output sem `window.open` | MIT | `TerminalView` (`linkHandler`) | 18 |
| Ligaduras/webfonts | `addons/addon-ligatures/src`, `addon-web-fonts/src` | acabamento de fonte, se usarmos JetBrains Mono | MIT | `TerminalView` (opcional) | 14 |
| Clipboard OSC 52 controlado | `addons/addon-clipboard/src` | copiar do terminal remoto, com confirmação | MIT | `TerminalView` (opt-in) | 12 |
| Attach via WebSocket | `addons/addon-attach/src` | não usamos WebSocket; nosso PTY é IPC | MIT | não propor | 8 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Renderer DOM inteiro | já é o padrão do xterm; não precisamos de fork |
| `addon-attach` | nosso transporte é `node-pty` + IPC, não WebSocket |
| `addon-image` | superfície e memória altas; output de agente raramente usa sixel |
| Watermark de 50 MB | é “paraquedas”, não flow control; o Terax tem solução melhor |
| `headless/` | não está implementado neste clone |
| APIs propostas | `allowProposedApi: false` é a nossa postura atual |
| Fork do parser | o upstream cobre VT; fork aumenta custo de segurança |
| Abas e explorador de arquivos | não existem no pacote (não encontrado); são responsabilidade do host |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto para o `TerminalView` atual:

1. **Renderer**: após `term.open(host)`, tentar `new WebglAddon()`; se
   `onContextLoss` disparar, `dispose()` e manter o DOM. Não carregar WebGL em
   ambiente sem GPU (`navigator.gpu`/`WebGL2` check). Medir FPS e tempo de
   `write` de 1 MB antes/depois.
2. **Busca**: `SearchAddon` com `decorations` (highlight + active match),
   `onDidChangeResults` para o contador, `Ctrl+F`/`Escape` no `TerminalView`.
   Não usar `window.find` (não vê o canvas).
3. **Snapshot**: trocar o buffer de 200k chars por `SerializeAddon.serialize()`
   no unmount e a cada N segundos; guardar no main por `terminalId`. O snapshot
   não deve conter OSC 52/links ativos; serializar só células.
4. **Links**: `term.options.linkHandler = { activate: (_e, uri) => openExternal(uri) }`
   com allow-list `https:`/`http:`; `OscLinkProvider` já entrega a URI, mas a
   decisão é nossa.
5. **Unicode**: carregar `UnicodeGraphemeProvider` (addon) e definir
   `unicode.activeVersion = '15-graphemes'`; testar com emoji de largura 2 e
   bandeiras.
6. **Teste**: fixture de 1 MB de output com cores, emoji, hyperlink OSC 8 e
   OSC 52; verificar que (a) não abre nada sem handler, (b) o snapshot restaura
   a tela, (c) o WebGL cai para DOM sem perder conteúdo.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/desktop-ui/xtermjs--xterm.js rev-parse HEAD
991857a1b1cacf06f9531ba74a6e927a7a6398bb

$ sed -n '20,33p' src/common/input/WriteBuffer.ts
DISCARD_WATERMARK = 50000000; WRITE_TIMEOUT_MS = 12; WRITE_BUFFER_LENGTH_THRESHOLD = 50

$ sed -n '156,180p' src/browser/services/RenderService.ts
refreshRows(start,end) → this._renderDebouncer.refresh(...)

$ sed -n '536,580p' src/browser/CoreBrowserTerminal.ts
this._renderService = ...createInstance(RenderService, this.rows, this.screenElement)
this._renderService.setRenderer(this._createRenderer())

$ sed -n '51,90p' addons/addon-webgl/src/WebglAddon.ts
activate(terminal) ... new WebglRenderer(...) ... onContextLoss

$ sed -n '55,90p' addons/addon-fit/src/FitAddon.ts
proposeDimensions() → this._terminal.resize(dims.cols, dims.rows)

$ sed -n '24,36p' addons/addon-web-links/src/WebLinksAddon.ts
const newWindow = window.open(); newWindow.opener = null

$ grep -n "onData\|terminal.write\|snapshot" src/renderer/src/components/TerminalPane.tsx
63: if (ready) term.write(event.data)
76: const input = term.onData((data) => window.forja.terminal.write(info.id, data))
69: window.forja.terminal.snapshot(info.id).then(...)
```

Limitações: não rodei os testes nem o benchmark. O clone não contém a
implementação `headless`; a análise de performance é baseada nas constantes e no
fluxo do código, não em medição.
