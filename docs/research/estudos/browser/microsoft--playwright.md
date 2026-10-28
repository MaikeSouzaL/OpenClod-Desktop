# Playwright

| Campo | Valor |
|---|---|
| Repositório | https://github.com/microsoft/playwright |
| Clone local | `repositorios/_research/browser/microsoft--playwright` |
| Commit | `91a765d1681cb3eeb0d0fb89fefec3cf0d21bd9b` (2026-10-24) |
| Licença | Apache-2.0 (`LICENSE:1-2`; `NOTICE`) |
| Categoria | browser / motor de automação + MCP/CLI + extensão |
| Stack | TypeScript, Node ≥20, npm workspaces, `zod`, protocolo gerado de `spec/*.yml` |
| Tamanho | 1.596 fontes TS (~591 mil linhas); 542 `*.spec.ts`; `playwright-core` 1.65.0-next |

## 1. O que é (verificado no código)

É um motor de automação com três camadas bem separadas: cliente
(`packages/playwright-core/src/client`), servidor (`.../src/server`) e scripts injetados
(`packages/injected/src`) — a regra "cliente nunca importa servidor" está em
`AGENTS.md` e é imposta por `DEPS.list`. Por cima do motor, este commit traz um
**backend de ferramentas para agentes** em `packages/playwright-core/src/tools/backend`
(`browser_snapshot`, `browser_click`, `browser_find`, `browser_verify_*`), usado tanto
pelo MCP quanto pelo CLI. Para nós o valor não é portar o motor (impossível: ~600 mil
linhas e protocolo próprio) e sim **usar `playwright` como dependência** — que já é o
caso (`package.json:27`) — e copiar os padrões de snapshot, resolução de alvo, espera e
verificação que o time deles consolidou.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `npm run build` / `npm run watch` | `package.json` (raiz) | build dos pacotes e geração de tipos/canais |
| `npm run flint` | `AGENTS.md` (Build) | eslint + tsc + doclint + geração |
| `npm run ctest <spec>` | `tests/page/*` | testes de página só em Chromium |
| `decorateMCPCommand` | `tools/mcp/program.ts:34-197` | servidor MCP com as tools de `tools/backend` |
| `decorateCliDaemonProgram` | `tools/index.ts:34` | CLI persistente com daemon e os mesmos comandos |
| `npx playwright test` | `packages/playwright/src/program.ts:41` | test runner (`@playwright/test`) |

Superfície de ferramentas (famílias): navegação (`navigate.ts`), snapshot/find
(`snapshot.ts`, `find.ts`), mouse/teclado (`mouse.ts`, `keyboard.ts`), formulário
(`form.ts`), abas (`tabs.ts`), storage/cookies (`storage.ts`, `cookies.ts`), rede
(`network.ts`, `route.ts`), tracing/vídeo (`tracing.ts`, `video.ts`) e verificação
(`verify.ts`). Cada tool declara `capability` (`core`, `core-input`, `testing`) e
`type` (`readOnly`, `input`, `assertion`), o que permite filtrar o que o agente vê.

## 3. Arquitetura e fluxo

```
tools/backend/*.ts (defineTabTool)
  → client (Locator/Page) → protocolo (channels) → server (Frame/Page/Context)
    → injected (injectedScript.ts) no renderer
      → CDP (chromium) / Juggler (firefox) / WebKit inspector
        → resultado → response.ts (snapshot + código gerado) → MCP/CLI
```

- Entry point da biblioteca: `packages/playwright-core/src/index.ts`; do agente:
  `packages/playwright-core/src/tools/index.ts`.
- "Loop": não há loop de LLM; há uma chamada de tool por vez, sem estado de conversa.
- Execução: `tools/backend/tab.ts:578-599` resolve o alvo e chama `locator.click`.
- Streaming: não é o foco; eventos de página via `client/page.ts` (`waitForRequest`,
  `waitForResponse` em `:477-499`).
- Persistência: `storageState` (`server/browserContext.ts:603`) e trace
  (`client/tracing.ts:46-105`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `browser_snapshot` | `tools/backend/snapshot.ts:35-56` | snapshot ARIA opcionalmente com `boxes` e `depth` | baixo |
| `browser_click` | `tools/backend/snapshot.ts:64-98` | clique por `target` (ref/seletor/locator) | médio |
| `browser_find` | `tools/backend/find.ts:24-125` | busca texto/regex no snapshot com ancestrais | baixo |
| `browser_verify_element_visible` | `tools/backend/verify.ts:24-49` | asserção por `role` + nome acessível | baixo |
| `browser_verify_text_visible` | `tools/backend/verify.ts:51-75` | asserção por texto visível | baixo |
| `browser_wait_for` | `tools/backend/wait.ts:22-73` | espera texto surgir/sumir ou tempo (máx. 30 s) | baixo |
| `browser_generate_locator` | `tools/backend/snapshot.ts:175-189` | devolve locator canônico do elemento | baixo |
| `browser_select_option` / `check` | `tools/backend/snapshot.ts:155-226` | `<select>`, checkbox/radio | baixo |
| `browser_route` / `network` | `tools/backend/route.ts`, `network.ts` | intercepta/mocka rede | alto |
| `browser_run_code` | `tools/backend/runCode.ts` | executa código no contexto | **alto** |

## 5. Loop do agente, contexto e streaming

Não existe loop de agente neste repositório; a "API de alto nível com IA" é o backend
de tools (`tools/backend/*.ts`), não um agente. O "contexto" é o snapshot ARIA devolvido a
cada tool que chama `response.setIncludeSnapshot()`
(`tools/backend/response.ts:159-169`). O snapshot é gerado por
`captureSnapshot(...)` com formato `text`/`json` (`response.ts:289-320`), opcionalmente
gravado em arquivo `.yml` em vez de voltar no corpo — corte de contexto por arquivo, não
por truncamento. `outputMaxSize` limita o payload total (`response.ts:237-254`).

Espera/retry ficam no motor, não no chamador: `ProgressController` centraliza deadline e
abort (`server/progress.ts:37-94`), e o script injetado repete a ação com backoff
enquanto o elemento estiver instável/destacado
(`packages/injected/src/injectedScript.ts:1124-1153`). Cancelamento é um
`AbortController` por operação (`progress.ts:45-73`).

## 6. Sessões, estado e persistência

`BrowserContext` é a unidade de isolamento; `storageState()` captura cookies +
`localStorage` e, opcionalmente, IndexedDB/OPFS/credentials
(`server/browserContext.ts:603-636`). O MCP escolhe o modo de sessão em um único ponto:
CDP (`connectOverCDP`), isolado, extensão ou persistente
(`tools/mcp/browserFactory.ts:71-82`). No modo persistente há detecção de perfil travado
com mensagem acionável (`:188-196`). Tracing grava DOM, ARIA, tela e fontes por chunk
(`client/tracing.ts:46-105`), o que dá replay fiel de uma sessão de agente.

## 7. Configuração e extensibilidade

Config do MCP/CLI em `tools/mcp/config.ts` e `configIni.ts`; precedência por flags >
arquivo > default (ver `browserFactory.ts:71-111`). Extensibilidade de seletor:
`selectors.register(name, script)` (`client/selectors.ts:26-38`). Há dois motores
internos que interessam: `aria-ref` (`injected/injectedScript.ts:247`) e
`internal:testid`. O "alvo" aceito pelas tools é polimórfico: ref do snapshot, CSS,
XPath ou uma expressão de locator em qualquer linguagem
(`tools/backend/tab.ts:583-644`).

## 8. Permissões, sandbox e erros

As tools são classificadas por `capability` e `type`; `browser_run_code` e `route` são
as de maior risco e podem ser desligadas por configuração de capabilities. Erros de
alvo são explícitos: ref desconhecido devolve mensagem que ensina o formato aceito
(`tools/backend/tab.ts:640-644`), e violação de strict mode lista os elementos
resolvidos (`injected/injectedScript.ts:1343-1347`). Não há sandbox de processo: o
navegador roda com o usuário do host.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Página | `tests/page/` | click, fill, locator, acessibilidade |
| Biblioteca | `tests/library/` | browser/context, cookies, permissões |
| MCP/CLI | `tests/mcp/` (ex.: `autowait.spec.ts`, `cli-find.spec.ts`) | ferramentas e comandos |
| Test runner | `tests/playwright-test/` | reporters, retries, fixtures |
| Total | 542 `*.spec.ts` | — |

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Snapshot ARIA "modo IA" + refs `eN` | `client/page.ts:938` + `injected/ariaSnapshot.ts:25-93` | árvore sem ruído, com ref resolvível por `aria-ref` | Apache-2.0 | `src/core/browser/snapshot.ts` (via API) | 25 |
| Resolução polimórfica de alvo (ref/CSS/XPath/locator) | `tools/backend/tab.ts:578-644` | um só campo `target` cobre todos os casos e ensina o formato no erro | Apache-2.0 | `src/core/browser/target.ts` | 24 |
| Ciclo de ação com estabilidade + hit-test + retry | `injected/injectedScript.ts:699-741`, `:1124-1153` | elimina clique em elemento que se moveu/está coberto | Apache-2.0 | `src/core/browser/action-loop.ts` | 23 |
| Modos de sessão (CDP/isolado/persistente/extensão) | `tools/mcp/browserFactory.ts:71-82` | decisão única e explícita, sem `if` espalhado | Apache-2.0 | `src/core/browser/session-mode.ts` | 22 |
| Ponte de extensão via relay CDP + tab group | `tools/mcp/extensionContextFactory.ts:29-44` + `packages/extension/manifest.json:5` | conecta ao Chrome do usuário sem duplicar perfil | Apache-2.0 | `src/main/chrome/bridge.ts` (referência) | 22 |
| `browser_find` (grep no snapshot com ancestrais) | `tools/backend/find.ts:24-125` | localizar sem despejar a árvore inteira no prompt | Apache-2.0 | `src/core/browser/find.ts` | 21 |
| Verificação por role + nome acessível | `tools/backend/verify.ts:24-75` | asserção barata e legível, sem LLM | Apache-2.0 | `src/core/browser/verify.ts` | 20 |
| `storageState` com IndexedDB/OPFS/credentials | `server/browserContext.ts:603-636` | retomada de sessão autenticada | Apache-2.0 | `src/core/browser/storage-state.ts` | 19 |
| Trace com DOM/ARIA/tela por chunk | `client/tracing.ts:46-105` | auditoria e replay de execução | Apache-2.0 | `src/core/browser/trace.ts` | 18 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Motor (client/server/injected/protocolo) | ~600 mil linhas e protocolo gerado; já consumimos como dependência |
| Test runner (`@playwright/test`) | não é o nosso produto; usar Vitest |
| `browser_run_code` / `route` como default | superfície de execução arbitrária; risco desproporcional |
| Recorder/codegen | útil para teste, não para o agente em produção |
| Tradução de locator entre linguagens | acoplado ao codegen deles |

## 12. Modelo de exemplo para o nosso harness

Manter `playwright` como dependência (já está em `package.json:27`) e portar apenas os
**padrões de contrato**:

1. `snapshot()` → `page.ariaSnapshot({ mode: 'ai' })`, com `depth` e `boxes`
   opcionais, como em `tools/backend/snapshot.ts:35-56`.
2. `target` único: `e12` (ref), `css=...`, `xpath=...` ou `role=button[name="Salvar"]`;
   erro de ref inválido deve dizer "rode snapshot de novo", como `tab.ts:640-644`.
3. `verify({ role, name })` e `verifyText(text)` como tools separadas — não pedir ao
   modelo para "confirmar" no texto livre.
4. `waitFor({ text, textGone, timeout≤30s })` com `Promise.race`, como
   `tools/backend/wait.ts:44-62`.
5. No nosso `layer.ts`, trocar `snapshot()` (`layer.ts:314-329`) por snapshot com refs
   e remover o `waitForTimeout` de `click` (`layer.ts:340`); passar a usar
   `locator.waitFor({state:'stable'})` antes do clique.
6. Para o Chrome do usuário, o desenho do relay (`extensionContextFactory.ts:29-44`) é
   o mesmo do nosso `ChromeBridge` (`src/main/chrome/bridge.ts:28-35`): manter.

Teste: página com botão coberto por banner fixo; exigir que `click` espere o banner
sumir ou reporte `blocked_by_overlay`, e que `verify` funcione sem nova chamada de LLM.

## 13. Evidências da análise

```text
git -C microsoft--playwright rev-parse HEAD
  91a765d1681cb3eeb0d0fb89fefec3cf0d21bd9b

package.json (playwright-core)      "version": "1.65.0-next"
packages/playwright-core/src/tools/backend/snapshot.ts:35  browser_snapshot
packages/playwright-core/src/tools/backend/find.ts:68      await tab.page.ariaSnapshot({ mode: 'ai' });
packages/playwright-core/src/tools/backend/tab.ts:640      const ref = target.match(/\[ref=((?:f\d+)?e\d+)\]/)?.[1];
packages/playwright-core/src/tools/backend/verify.ts:39    frame.getByRole(role, { name: accessibleName })
packages/playwright-core/src/tools/backend/wait.ts:60      const outcome = await Promise.race(waits);

packages/injected/src/injectedScript.ts:1124-1153  comentário "Life of a pointer action"
packages/injected/src/injectedScript.ts:699         checkElementStates(states inclui 'stable')
packages/injected/src/ariaSnapshot.ts:81            generateAriaTree(rootElement, options)
packages/playwright-core/src/client/page.ts:787     return this.locator(`aria-ref=${ref}`);
packages/playwright-core/src/client/page.ts:938     ariaSnapshot({ mode: 'ai' | 'default', depth, boxes })

packages/playwright-core/src/tools/mcp/browserFactory.ts:71-82  cdp/isolated/extension/persistent
packages/playwright-core/src/tools/mcp/extensionContextFactory.ts:43  connectOverCDP(relay.cdpEndpoint())
packages/extension/manifest.json:5                  "permissions": ["debugger","activeTab","tabs","tabGroups"]
packages/playwright-core/src/server/browserContext.ts:603  storageState(progress, {indexedDB, opfs, credentials})
packages/playwright-core/src/client/tracing.ts:46   async start({ snapshots, screenshots, sources })

Get-ChildItem tests -Recurse -Filter *.spec.ts | Measure-Object → 542
```
