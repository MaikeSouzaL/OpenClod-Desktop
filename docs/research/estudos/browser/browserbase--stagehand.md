# Stagehand

| Campo | Valor |
|---|---|
| Repositório | https://github.com/browserbase/stagehand |
| Clone local | `repositorios/_research/browser/browserbase--stagehand` |
| Commit | `8023f34161d650c196dc343d2c232fb5e129a826` (2026-10-23) |
| Licença | MIT (`LICENSE:1-3`) |
| Categoria | browser / SDK de agente + extensão MV3 + CLI `browse` |
| Stack | TypeScript ESM, Node ≥22.18, pnpm 11 + turbo, zod, oclif, oxlint/oxfmt, Vitest |
| Tamanho | 1.281 fontes TS (~225 mil linhas); 72 testes no SDK e 68 na extensão; SDK 4.3.0 |

## 1. O que é (verificado no código)

O Stagehand v4 separou o SDK do motor: `Stagehand` (`packages/sdk-ts/src/stagehand.ts:78`)
não automatiza nada — fala JSON-RPC com um "command server" que, na prática, é a
**extensão Chrome** (`packages/extension/`) ou um worker na nuvem da Browserbase.
As três operações de IA são `act`, `observe` e `extract`
(`stagehand.ts:245-320`) e o snapshot é um híbrido de árvore de acessibilidade + DOM,
com mapas de XPath e URL por elemento
(`packages/extension/understudy/a11y/snapshot/capture.ts:43-72`). Para nós é a fonte
mais próxima em stack: TypeScript, MIT, roda no Chrome do usuário via `chrome.debugger`.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pnpm test` | `package.json:22` | roda unit + browser via turbo |
| `pnpm test:unit` | `package.json:23` | Vitest de regras e scripts |
| `pnpm build` | `package.json:26` | build de todos os pacotes |
| `pnpm --filter ./packages/docs dev` | `package.json:18` | docs locais |
| `browse snapshot` | `packages/cli/src/commands/snapshot.ts:9-56` | imprime árvore e cacheia refs |
| `browse click/fill/type/press` | `packages/cli/src/commands/*.ts` | ações por ref ou seletor |
| `browse tab new/switch/close` | `packages/cli/src/commands/tab/*.ts` | abas |
| `browse daemon` | `packages/cli/src/commands/daemon.ts` | mantém sessão persistente |
| `Stagehand.create({ browser })` | `sdk-ts/src/stagehand.ts:92` | inicializa SDK sobre navegador já reivindicado |

O CLI `browse` tem **78 arquivos de comando** em `packages/cli/src/commands`, agrupados
em: navegação, snapshot/refs, mouse/teclado, formulário/upload, abas, rede, storage,
viewport, skills e cloud (projects/sessions/contexts/secrets).

## 3. Arquitetura e fluxo

```
SDK (sdk-ts/src/stagehand.ts:78)
  → RPCClient sobre CDP (cdpClient.ts) → command server
    → extensão MV3 (service-worker.ts) → controllers (page/locator/context)
      → understudy: Page/Frame/Locator + a11y snapshot (capture.ts)
        → chrome.debugger (CDP) → WebSocket/CDP real
```

- Entry point do SDK: `packages/sdk-ts/src/index.ts`; da extensão:
  `packages/extension/service-worker.ts`.
- Loop do agente: não há loop; `act` faz 1–2 inferências + self-heal
  (`extension/services/actService.ts:152-204`, `:399`).
- Execução de ferramenta: `packages/extension/controllers/*Controller.ts` +
  `understudy/locator.ts`.
- Streaming: não encontrado; inferência é `generateStructured` com JSON Schema
  (`extension/inference.ts:94-121`).
- Persistência: cache de ações (`extension/services/cacheService.ts`) e tracing
  (`extension/tracing.ts`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `stagehand.act(instruction)` | `sdk-ts/src/stagehand.ts:245-259` | executa instrução em linguagem natural | médio |
| `stagehand.observe(instruction?)` | `stagehand.ts:261-280` | lista ações/elementos possíveis | baixo |
| `stagehand.extract(instruction, schema?)` | `stagehand.ts:282-320` | extrai dados validados por zod | médio |
| `page.snapshot()` | `sdk-ts/src/page.ts:397-402` | árvore formatada + `xpathMap`/`urlMap` | baixo |
| `page.locator(selector)` | `page.ts:433-438` | locator com `click/fill/type/…` | baixo |
| `Locator.highlight()` | `sdk-ts/src/locator.ts:119-124` | destaca elemento para o humano | baixo |
| `Locator.centroid()` | `locator.ts:112-117` | coordenada do elemento | baixo |
| `page.screenshot({ mask })` | `page.ts:376-386` | captura mascarando locators | baixo |
| `stagehand.experimentalBatch(cb)` | `stagehand.ts:136-192` | roda N operações em 1 ida ao servidor | médio |
| `page.tools()` (WebMCP) | `page.ts:404-412` | lista tools declaradas pela própria página | alto |

## 5. Loop do agente, contexto e streaming

`act` monta o prompt com a árvore + lista fechada de ações suportadas
(`extension/prompt.ts`, `SupportedUnderstudyAction`) e chama a inferência com schema
zod (`extension/inference.ts:60-84`): `elementId`, `description`, `method`,
`arguments`, `twoStep`. Depois de executar, espera DOM/rede quietos
(`actService.ts:120`), tira um segundo snapshot e calcula `diffCombinedTrees`
(`actService.ts:203`); se a instrução pedia dois passos, usa o diff para o passo 2
(`buildStepTwoPrompt`). `selfHealAction` (`:399`) tenta recuperar quando o elemento
não resolve. `observe` devolve `Action[]` com `selector: xpath=...` derivado do
`combinedXpathMap` (`services/observeService.ts:150-151`).

Contexto: a árvore é formatada como `[frameOrdinal-backendNodeId] role: name`
(`understudy/a11y/snapshot/treeFormatUtils.ts:8-14`); o prompt explica que o ID tem
duas partes e deve ser copiado inteiro (`extension/prompt.ts:177`).

## 6. Sessões, estado e persistência

O SDK "reivindica" um navegador (`claimStagehandBrowser`, `stagehand.ts:94`) e libera ou
invalida no fechamento (`:322-330`). A sessão local é um Chrome MV3 com
`chrome.debugger`, `tabs`, `offscreen` e `scripting` (`extension/manifest.json:5`),
com heartbeat para o service worker não morrer
(`extension/service-worker-lifecycle/heartbeat-manager.ts`). O protocolo define
`pageId` estável e `PageRef` (`protocol/schemas.ts:1186-1192`). O CLI mantém um daemon
com PID e socket (`packages/cli/src/lib/driver/daemon/client.ts:178-220`) para reutilizar a
sessão entre comandos. Não há formato de retomada de conversa — o estado é a página.

## 7. Configuração e extensibilidade

Config do SDK por `StagehandCreateOptionsSchema` (`stagehand.ts:92-93`), com browser
local, Browserbase ou endpoint CDP. A extensão tem `timeoutConfig.ts` e
`runtimeCompatibility.ts`; o CLI lê flags + config (`cli/src/lib/driver/flags.ts`).
Ferramentas da página via WebMCP (`page.tools()`, `sdk-ts/src/webmcp.ts`) são um canal de
extensibilidade novo: o site declara ações que o agente pode chamar. Skills do CLI em
`packages/cli/src/commands/skills/*`.

## 8. Permissões, sandbox e erros

O modelo de permissão é o do Chrome: a extensão pede `debugger` + `<all_urls>`
(`extension/manifest.json:5-6`) e o usuário autoriza uma vez. Há política de domínio
(`extension/understudy/domainPolicy.ts`) e timeout central por `Progress`
(`extension/understudy/progress.ts:13-45`), com deadline compartilhado e abort. Erros de
RPC são tipados (`sdk-ts/src/rpcErrors.ts`) e a inicialização trata falha ambígua
invalidando o navegador (`stagehand.ts:104-121`). Não há sandbox de processo; o
isolamento real é por contexto da Browserbase ou por perfil local.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| SDK unitário | `packages/sdk-ts/tests` (72) | locator, page, protocolo, batch |
| Extensão | `packages/extension/**/*.test.ts` (68) | locator, a11y tree, cookies, wait |
| Protocolo | `packages/protocol/tests/protocol` | schemas, wire casing, versão |
| Integração | `scripts/test-integration.ts` | fluxo ponta a ponta |
| Evals | `packages/evals` | qualidade de act/observe/extract |

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Snapshot híbrido AX + DOM com `xpathMap`/`urlMap` e iframes | `extension/understudy/a11y/snapshot/capture.ts:43-72` | resolve ref→elemento sem depender de índice efêmero | MIT | `src/core/browser/snapshot/` | 25 |
| ID codificado `frame-backendNodeId` + formatador de árvore | `a11y/snapshot/treeFormatUtils.ts:8-14` + `prompt.ts:177` | ID estável e legível, com frame explícito | MIT | `src/core/browser/ref.ts` | 24 |
| `observe` → `Action[]` com `selector` derivado | `services/observeService.ts:87-151` | separa "descobrir" de "agir"; cacheável | MIT | `src/core/browser/observe.ts` | 23 |
| `act` em dois passos com diff de árvore + self-heal | `services/actService.ts:203-204`, `:399` | verifica efeito real antes de continuar | MIT | `src/core/browser/act.ts` | 23 |
| Resolução de refs no CLI (`@e5`, `[0-12]`, `ref=`) | `cli/src/lib/driver/commands/selectors.ts:12-48` | erro `stale_ref` explícito e mapa por sessão | MIT | `src/core/browser/ref-map.ts` | 21 |
| Filtro/compactação de snapshot (`--filter`, `--max-depth`) | `cli/src/lib/driver/commands/snapshot-format.ts:7-92` | corta contexto sem perder ancestrais | MIT | `src/core/browser/snapshot/format.ts` | 21 |
| `Progress` com deadline único e abort | `extension/understudy/progress.ts:13-145` | um timeout para a operação inteira, não por passo | MIT | `src/core/browser/deadline.ts` | 19 |
| Schemas de protocolo (`Action`, `SnapshotResult`, `Locator`) | `protocol/schemas.ts:852-877`, `:1165-1184`, `:1415-1420` | contrato estável e validável entre camadas | MIT | `src/core/browser/protocol.ts` | 18 |
| Máscara de screenshot por locator | `sdk-ts/src/page.ts:376-386` | esconde PII em evidência visual | MIT | `src/core/browser/screenshot.ts` | 16 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Runtime completo da extensão (`understudy/*`) | ~40 arquivos acoplados a `chrome.debugger` e ao protocolo deles |
| Cliente Browserbase / cloud sessions | dependência comercial; nosso modo é Chrome local |
| CLI `browse` inteiro (78 comandos) | duplica nossa superfície de tools; portar só snapshot/ref |
| Protocolo JSON-RPC v4 | nosso harness é in-process; RPC só se separarmos processos |
| Camada LLM (`extension/llm/*`) | já temos roteador de modelos |
| Evals | úteis como referência, não como código |

## 12. Modelo de exemplo para o nosso harness

Este é o desenho que mais se encaixa no Openclod:

1. `snapshot()` devolve `{ tree, xpathMap, urlMap }` — não só texto. O modelo escolhe
   `elementId`; o executor traduz para XPath e age (padrão de
   `capture.ts:43-72` + `observeService.ts:150`).
2. `observe(instruction)` é uma tool separada e cacheável; `act` consome o resultado.
3. `act` sempre tira um segundo snapshot e devolve `changed: boolean` + `diff` — é a
   nossa verificação de resultado, hoje inexistente em `layer.ts`.
4. Refs vivem em um `RefMap` por sessão, com erro `stale_ref` e instrução de re-snapshot
   (`selectors.ts:35-48`); nosso `layer.ts` não tem esse conceito.
5. Reaproveitar o formato `[0-42] button: Salvar` e o filtro por profundidade
   (`snapshot-format.ts:7-92`) para caber no orçamento de contexto.

Teste: página com iframe same-origin e shadow DOM; exigir que `observe` devolva XPath
absoluto correto, que `act` reporte `changed=true` e que um ref velho falhe com
`stale_ref` em vez de clicar no elemento errado.

## 13. Evidências da análise

```text
git -C browserbase--stagehand rev-parse HEAD
  8023f34161d650c196dc343d2c232fb5e129a826

package.json (workspace)            "version": "4.0.0"; packageManager pnpm 11.11.0
packages/sdk-ts/package.json:3      "version": "4.3.0"
packages/sdk-ts/src/stagehand.ts:78 export class Stagehand
packages/sdk-ts/src/stagehand.ts:245-320  act / observe / extract
packages/sdk-ts/src/page.ts:397      async snapshot(): Promise<SnapshotResult>
packages/sdk-ts/src/locator.ts:24    export class Locator

packages/protocol/schemas.ts:852     ActionSchema { selector, description, method, arguments }
packages/protocol/schemas.ts:1165    SnapshotResultSchema { formattedTree, xpathMap, urlMap }
packages/protocol/schemas.ts:1173    PageSnapshotOptionsSchema { timeout=20000, includeIframes }
packages/protocol/schemas.ts:1415    LocatorDescriptorSchema { pageId, selector, nth? }

packages/extension/manifest.json:5   permissions: debugger, offscreen, scripting, tabs
packages/extension/understudy/a11y/snapshot/capture.ts:60  captureHybridSnapshot(...)
packages/extension/understudy/a11y/snapshot/a11yTree.ts:20 a11yForFrame(...)
packages/extension/understudy/a11y/snapshot/treeFormatUtils.ts:12  `[id] role: name`
packages/extension/prompt.ts:177     ID = "frame ordinal + backend node ID"
packages/extension/inference.ts:60   ActInferenceSchema (elementId, method, twoStep)
packages/extension/services/actService.ts:203  diffCombinedTrees(combinedTree, nextTree)
packages/extension/services/actService.ts:399  selfHealAction(...)
packages/extension/services/observeService.ts:150  selector: `xpath=${sourceXpath}`
packages/extension/understudy/progress.ts:13  class Progress (deadline + AbortController)

packages/cli/src/lib/driver/commands/selectors.ts:35  resolveSelector(...)
packages/cli/src/lib/driver/commands/snapshot-format.ts:7 formatSnapshotTree(...)
Get-ChildItem packages/cli/src/commands -Recurse -Filter *.ts | Measure-Object → 78
```
