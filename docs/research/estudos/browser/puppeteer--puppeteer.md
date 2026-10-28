# Puppeteer

| Campo | Valor |
|---|---|
| Repositório | https://github.com/puppeteer/puppeteer |
| Clone local | `repositorios/_research/browser/puppeteer--puppeteer` |
| Commit | `08e7b1aebe60462b6f7834e9dfe0f6c70464247c` (2026-10-24) |
| Licença | Apache-2.0 (`LICENSE:1-3`) |
| Categoria | browser / driver CDP + API de alto nível (Node e browser) |
| Stack | TypeScript, Node ≥22, wireit, mocha, npm workspaces; `puppeteer-core` 25.16.0 |
| Tamanho | 499 fontes TS (~102 mil linhas); 77 arquivos em `test/src` |

## 1. O que é (verificado no código)

É um cliente CDP de alto nível: `puppeteer-core` não baixa navegador e expõe
`Puppeteer.connect` + `launch` (`packages/puppeteer-core/src/common/Puppeteer.ts:36-123`).
O pacote `puppeteer` é o wrapper que baixa Chrome. O entrypoint real é
`packages/puppeteer-core/src/index.ts`, que só reexporta
`./index-browser.js` e `./node/node.js`. Comparado ao Playwright, a API é menor e mais
"manual": o auto-wait existe no `Locator` (novo) mas `ElementHandle.click` ainda faz
scroll + clique por coordenada (`api/ElementHandle.ts:769-775`). Não há camada de IA,
MCP ou agente — "não encontrado" em todo o repositório. Para nós serve como
**alternativa de dependência** e como fonte de padrões de espera/estabilidade.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `npm run build` | `package.json:10` | build via wireit |
| `npm run test:chrome` | `package.json:29` | suíte completa em Chrome |
| `npm run test:chrome:bidi` | `package.json:30` | mesma suíte sobre WebDriver BiDi |
| `npm run unit` | `package.json:41` | testes unitários por workspace |
| `npm run docs` | `package.json:15` | gera API docs |
| `puppeteer browsers install chrome` | `packages/puppeteer/src` | instala navegador |
| `Puppeteer.connect({ browserURL })` | `common/BrowserConnector.ts:63-77` | anexa a um Chrome já aberto |

A superfície de biblioteca é: `launch`, `connect`, `createBrowserContext`, `newPage`,
`page.locator`, `page.waitForSelector`, `page.waitForNetworkIdle`,
`page.screenshot`, `page.createCDPSession`.

## 3. Arquitetura e fluxo

```
Puppeteer.launch | Puppeteer.connect (common/BrowserConnector.ts:32-56)
  → Browser (cdp ou bidi) → BrowserContext → Page → Frame
    → WaitTask (common/WaitTask.ts:32) + QueryHandler (common/GetQueryHandler.ts:19)
      → ElementHandle / Locator (api/locators/locators.ts:117)
        → CDP Input.dispatchMouseEvent / Runtime.callFunctionOn
```

- Entry point: `packages/puppeteer-core/src/index.ts:7-8`.
- Loop: não existe; cada chamada é uma operação isolada.
- Execução de ação: `api/ElementHandle.ts:756-775` (scroll + `clickablePoint` + clique).
- Espera: `common/WaitTask.ts:32-120` (polling `raf`, `mutation` ou intervalo).
- Persistência: cookies e storage ficam no `BrowserContext`; não há formato de sessão
  serializável como o `storageState` do Playwright — "não encontrado".

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `page.goto` / `reload` / `goBack` | `api/Page.ts` | navegação com `waitUntil` | baixo |
| `page.waitForSelector` | `api/Frame.ts:759` | espera seletor com estado (`visible` etc.) | baixo |
| `page.waitForNetworkIdle` | `api/Page.ts:2088-2096` | espera rede ociosa | baixo |
| `page.locator(...)` | `api/locators/locators.ts:117` | ação com retry e estabilidade | baixo |
| `Locator.race([...])` | `api/locators/locators.ts:140-143` | aceita o primeiro de vários seletores | baixo |
| `ElementHandle.click` | `api/ElementHandle.ts:769-775` | scroll + clique por coordenada | médio |
| `page.createCDPSession` | `api/Page.ts:1061` | acesso cru ao CDP | **alto** |
| `page.screenshot` | `cdp/Page.ts:1197-1242` | clip, `captureBeyondViewport`, `fromSurface` | baixo |
| `page.setBypassCSP` | `api/Page.ts:2255` | desliga CSP (para injeção) | alto |
| `browser.createBrowserContext` | `api/Browser.ts:544` | isolamento por contexto | baixo |

## 5. Loop do agente, contexto e streaming

Não há agente nem streaming de modelo. Verificação de resultado embutida: **não
encontrado** — quem chama precisa reler o estado. O que existe é um **modelo de retry por
operação**: `Locator` guarda operadores de espera e usa
`retryAndRaceWithSignalAndTimer` (`api/locators/locators.ts:179-190`) para repetir até
o timeout ou o sinal abortar. A estabilidade do elemento é opcional e ligada por
default (`#waitForStableBoundingBox`, `:161`, `:266-271`), comparando duas medições de
bounding box em frames consecutivos (`:327-337`). `WaitTask` escolhe o poller:
`RAF`, `MutationObserver` ou intervalo em ms (`common/WaitTask.ts:100-120`), e cancela
ao navegar (`:226`).

## 6. Sessões, estado e persistência

`BrowserContext` é o isolamento; `browser.createBrowserContext()` cria um contexto
anônimo e `browserContexts()` lista os existentes (`api/Browser.ts:544-562`). Para o
Chrome do usuário, `connect` aceita `browserURL`, `browserWSEndpoint`, `transport` ou
`channel`, com a regra "exatamente um" (`common/BrowserConnector.ts:63-77`). Não há
serialização de storage pronta; quem quiser retomar cookies precisa ler via CDP ou
usar `userDataDir` persistente no launch (`node/BrowserLauncher.ts:216-238`). Sessão de
vídeo/gravação de tela existe em `api/ScreenRecording.ts`.

## 7. Configuração e extensibilidade

Config por opções de `launch`/`connect` (`node/LaunchOptions.ts`, `common/ConnectOptions.ts`).
Seletores são plugáveis por `QueryHandler` (`common/GetQueryHandler.ts:19-22`):
`css`, `pierce`, `aria`, `text`, `xpath`, escolhidos pela sintaxe `::-p-*` ou
`aria/...`. O parser de P-selectors (`common/PSelectorParser.ts:39-120`) suporta
combinadores `>` e `>>>` (pierce) e as pseudo-classes `::-p-text`, `::-p-xpath` e
`::-p-aria`. Handlers são registrados por
`CustomQueryHandler` (`common/CustomQueryHandler.ts`) — mesma ideia do
`selectors.register` do Playwright, com menos cerimônia.

## 8. Permissões, sandbox e erros

Não há modelo de permissão por ferramenta; o processo Node tem os privilégios do host e
o navegador roda em sandbox do Chromium. `setBypassCSP` (`api/Page.ts:2255`) e
`createCDPSession` (`:1061`) são as portas de escape. Erros são `TimeoutError` com
mensagem de espera (`common/WaitTask.ts:76-82`) e rejeição em navegação (`:226`).
`BrowserLauncher` recusa perfil já em uso e diretório não gravável
(`node/BrowserLauncher.ts:336-347`). Para o Chrome do usuário há um exemplo de
extensão que roda `puppeteer-core` dentro do service worker com `chrome.debugger`
(`examples/puppeteer-in-extension/manifest.json:9`) — é exemplo, não produto.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Comportamento | `test/src/*.test.ts` (77 arquivos) | click, cookies, connect, coverage, drag |
| Acessibilidade/ARIA | `test/src/ariaqueryhandler.test.ts`, `accessibility.test.ts` | query handler ARIA |
| Instalação | `test/installation` | download/execução de navegador |
| Expectativas | `test/TestExpectations.json` | falhas conhecidas por plataforma |
| Cross-browser | `test/golden-chrome`, `test/golden-firefox` | screenshots de referência |

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Espera de bounding box estável antes de agir | `api/locators/locators.ts:161`, `:327-337` | resolve elemento que "anda" por animação | Apache-2.0 | `src/core/browser/stability.ts` | 19 |
| `Locator.race` de múltiplos seletores | `api/locators/locators.ts:140-143` | heurística sem LLM: primeiro que existir vence | Apache-2.0 | `src/core/browser/target.ts` | 18 |
| Poller configurável (`raf`/`mutation`/ms) | `common/WaitTask.ts:100-120` | espera barata e previsível | Apache-2.0 | `src/core/browser/wait.ts` | 17 |
| Registro de query handlers por sintaxe | `common/GetQueryHandler.ts:19-70` | extensível sem tocar no núcleo | Apache-2.0 | `src/core/browser/selectors.ts` | 16 |
| `connect` com "exatamente uma" forma de endpoint | `common/BrowserConnector.ts:63-77` | validação clara de modo de conexão | Apache-2.0 | `src/main/chrome/bridge.ts` | 15 |
| Screenshot com clip e `captureBeyondViewport` | `cdp/Page.ts:1197-1242` | captura previsível de região | Apache-2.0 | `src/core/browser/screenshot.ts` | 14 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Motor CDP/BiDi completo | já usamos Playwright; dois motores = dobro de manutenção |
| `puppeteer` (pacote que baixa Chrome) | nosso app já usa canal do sistema (`chrome`/`msedge`) |
| API `ElementHandle` baseada em coordenada | inferior ao locator com actionability do Playwright |
| WebDriver BiDi | cobertura menor no nosso alvo (Chrome desktop) |
| Exemplo de extensão | demonstração, sem tratamento de reconexão/perfil |

## 12. Modelo de exemplo para o nosso harness

Puppeteer entra como **segunda opinião**, não como segundo motor:

1. Se um dia precisarmos de um caminho sem Playwright, `puppeteer-core` é a dependência
   mínima (não baixa navegador) e `connect({ browserURL })` cobre o Chrome já aberto.
2. Copiar o conceito de `Locator` com `setTimeout` e `setWaitForStableBoundingBox`
   (`locators.ts:208-271`): nossa camada hoje só tem `setDefaultTimeout` e um
   `waitForTimeout` fixo após clique (`layer.ts:210`, `layer.ts:340`).
3. Copiar a ideia de "race" para o nosso `locate()` (`layer.ts:419-429`): tentar
   `ref` → `role+name` → `text` → `selector`, e devolver qual venceu para auditoria.
4. Não copiar `ElementHandle.click`: preferir `locator.click()` com actionability.

Teste: botão com animação de 400 ms; exigir que o clique só ocorra depois de duas
medições de bounding box iguais e que o relatório diga qual seletor venceu o race.

## 13. Evidências da análise

```text
git -C puppeteer--puppeteer rev-parse HEAD
  08e7b1aebe60462b6f7834e9dfe0f6c70464247c

packages/puppeteer-core/package.json:3   "version": "25.16.0"
packages/puppeteer-core/src/index.ts:7-8 export * from './index-browser.js'; './node/node.js'
packages/puppeteer-core/src/common/Puppeteer.ts:123  connect(options): Promise<Browser>
packages/puppeteer-core/src/common/BrowserConnector.ts:66-77  browserWSEndpoint|browserURL|transport|channel
packages/puppeteer-core/src/api/ElementHandle.ts:769-775  click → scrollIntoViewIfNeeded + clickablePoint
packages/puppeteer-core/src/api/locators/locators.ts:140   static race(...)
packages/puppeteer-core/src/api/locators/locators.ts:266   setWaitForStableBoundingBox(...)
packages/puppeteer-core/src/api/locators/locators.ts:327   #waitForStableBoundingBoxIfNeeded
packages/puppeteer-core/src/common/WaitTask.ts:100-120     polling raf/mutation/number
packages/puppeteer-core/src/common/GetQueryHandler.ts:19-22 aria/pierce/xpath/text
packages/puppeteer-core/src/common/TimeoutSettings.ts:7     DEFAULT_TIMEOUT = 30000
packages/puppeteer-core/src/cdp/Page.ts:1197-1242         fromSurface, clip, captureBeyondViewport
packages/puppeteer-core/src/api/Page.ts:2088             waitForNetworkIdle

examples/puppeteer-in-extension/manifest.json:9          permissions: ["debugger","background"]
Get-ChildItem test/src -Recurse -File | Measure-Object → 77
```
