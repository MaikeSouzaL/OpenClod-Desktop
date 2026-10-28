# Estudos de navegador — resumo e prioridades

> Quatro clones analisados estaticamente em `repositorios/_research/browser/`.
> Método: leitura de código, sem instalar dependências e sem rodar os testes dos
> clones. Cada estudo individual tem 13 seções e cita caminho+linha.
> Data da análise: 2026-10-26.
> Alvo: `src/core/browser/layer.ts` (452 linhas) e o backend `ChromeBridge`
> (`src/main/chrome/bridge.ts:35`).

## Veredito por repositório

| Repositório | O que é de fato | Valor para o Openclod | Risco |
|---|---|---|---|
| `browserbase--stagehand` | SDK + extensão MV3 com snapshot AX+DOM e `act/observe/extract` | mais próximo em stack e licença; melhor snapshot com mapas de XPath | runtime acoplado ao protocolo deles |
| `microsoft--playwright` | motor + backend de tools para agentes | melhor contrato de snapshot/ref, alvo e actionability | não portar o motor; usar como dependência |
| `browser-use--browser-use` | agente Python sobre CDP com serializer próprio | melhor ideia de identidade de elemento entre passos | Python e ~94 mil linhas |
| `puppeteer--puppeteer` | driver CDP de alto nível | padrões pontuais de estabilidade e race de seletores | API inferior para agente; segundo motor |

**Regra de reúso:** Playwright e Puppeteer entram como **dependência** (Playwright já está
em `package.json:27`); browser-use entra como **conceito** (Python); Stagehand entra como
**porta de módulos puros** (TypeScript/MIT), com aviso de copyright.

## 10 candidatos priorizados

Score 0–25 = encaixe no nosso harness (0–10) + qualidade/testes (0–5) +
robustez de segurança/bordas (0–5) + portabilidade/licença (0–5).

| # | Candidato | Origem (arquivo:linha) | Score | Tipo | Destino proposto |
|---|---|---|---:|---|---|
| 1 | Snapshot híbrido AX+DOM com `xpathMap`/`urlMap`, iframes e escopo por locator | `browserbase--stagehand/packages/extension/understudy/a11y/snapshot/capture.ts:43-72` | 25 | porta | `src/core/browser/snapshot/capture.ts` |
| 2 | Snapshot ARIA "modo IA" + refs resolvíveis por `aria-ref` | `microsoft--playwright/packages/injected/src/ariaSnapshot.ts:25-93` e `packages/playwright-core/src/client/page.ts:787` | 25 | dependência | `src/core/browser/snapshot/aria.ts` |
| 3 | ID codificado `frame-backendNodeId` + formatador `[id] role: name` | `browserbase--stagehand/packages/extension/understudy/a11y/snapshot/treeFormatUtils.ts:8-14` e `packages/extension/prompt.ts:177` | 24 | porta | `src/core/browser/ref.ts` |
| 4 | Resolução polimórfica de alvo (ref/CSS/XPath/locator) com erro didático | `microsoft--playwright/packages/playwright-core/src/tools/backend/tab.ts:578-644` | 24 | reimplementação | `src/core/browser/target.ts` |
| 5 | Escada de identidade EXACT→STABLE→XPATH→AX_NAME→ATTRIBUTE | `browser-use--browser-use/browser_use/dom/views.py:165-185` e `browser_use/agent/service.py:3565-3710` | 24 | porta | `src/core/browser/element-identity.ts` |
| 6 | `observe` → `Action[]` e `act` em dois passos com diff + self-heal | `browserbase--stagehand/packages/extension/services/observeService.ts:87-151` e `actService.ts:203-204`, `:399` | 23 | porta | `src/core/browser/act.ts` |
| 7 | Ciclo de ação com estabilidade, scroll alternado, hit-test e retry | `microsoft--playwright/packages/injected/src/injectedScript.ts:699-741`, `:1124-1153` | 23 | reimplementação | `src/core/browser/action-loop.ts` |
| 8 | Índice = `backendNodeId` com alocação sintética sem colisão | `browser-use--browser-use/browser_use/dom/serializer/serializer.py:637-770` | 22 | porta | `src/core/browser/ref-allocator.ts` |
| 9 | Modos de sessão explícitos (CDP / isolado / persistente / extensão) | `microsoft--playwright/packages/playwright-core/src/tools/mcp/browserFactory.ts:71-82` | 22 | reimplementação | `src/core/browser/session-mode.ts` |
| 10 | Ponte de extensão via relay CDP + tab group (Chrome do usuário) | `microsoft--playwright/packages/playwright-core/src/tools/mcp/extensionContextFactory.ts:29-44` | 22 | referência | `src/main/chrome/bridge.ts` |

### Não priorizados (mas estudados)

| Item | Score | Por que ficou fora do top 10 |
|---|---:|---|
| Mapa de refs por sessão com erro `stale_ref` (`stagehand/packages/cli/src/lib/driver/commands/selectors.ts:12-48`) | 21 | entra junto com o item 3 |
| Clique com hit-test/occlusão via CDP (`browser-use/.../default_action_watchdog.py:574-620`) | 21 | depende do action-loop (item 7) |
| `browser_find`: grep no snapshot com ancestrais (`playwright/.../find.ts:24-125`) | 21 | barato, mas depois do snapshot com refs |
| Filtro/compactação de snapshot (`stagehand/.../snapshot-format.ts:7-92`) | 21 | complemento do item 1 |
| Redação de campos sensíveis (`browser-use/.../enhanced_snapshot.py:46-67`) | 20 | alto valor, baixo custo; pode subir |
| Verificação por role + nome acessível (`playwright/.../verify.ts:24-75`) | 20 | entra depois de `verify` genérico |
| `storageState` com IndexedDB/OPFS (`playwright/.../browserContext.ts:603-636`) | 19 | só quando houver retomada de sessão |
| `Progress` com deadline único e abort (`stagehand/.../progress.ts:13-145`) | 19 | refatoração interna |
| Espera de bounding box estável (`puppeteer/.../locators.ts:266-337`) | 19 | coberto pelo item 7 |
| `Locator.race` entre seletores (`puppeteer/.../locators.ts:140-143`) | 18 | parte do item 4 |
| `ActionResult` tipado (`browser-use/browser_use/agent/views.py:307-380`) | 18 | útil quando houver loop de agente |
| Schemas de protocolo (`stagehand/packages/protocol/schemas.ts:852-877`) | 18 | só se separarmos processos |
| Trace DOM/ARIA/tela (`playwright/.../tracing.ts:46-105`) | 18 | auditoria, não caminho crítico |
| Máscara de screenshot por locator (`stagehand/packages/sdk-ts/src/page.ts:376-386`) | 16 | evidência visual com PII |

## Lacunas do nosso `layer.ts`

1. **Snapshot sem referência.** `snapshot()` devolve só `tree`/`url`/`title`
   (`src/core/browser/layer.ts:9-13`, `:314-329`). Sem `refs`, toda ação depende de
   role+name ou CSS, que quebram em página dinâmica.
2. **Clique sem actionability.** `click()` chama `locator.first().click()` e dorme 250 ms
   fixos (`layer.ts:337-341`). Não há espera de estabilidade, hit-test nem detecção de
   overlay.
3. **`locate()` confunde `name` com texto.** Quando só há `name`, cai em `getByText`
   (`layer.ts:427`), o que erra em botão cujo nome acessível difere do texto.
4. **Sem verificação de resultado.** Nada compara URL/título/DOM antes e depois; o
   chamador só recebe a URL (`layer.ts:341`).
5. **Sem invalidação de refs.** Não existe mapa de refs; consequentemente não existe
   `stale_ref` após navegação.
6. **Timeouts fixos.** `setDefaultTimeout(15_000)` (`layer.ts:210`) e `8000` no snapshot
   (`layer.ts:323`), sem deadline único por operação.
7. **Screenshot só da viewport.** `fullPage: false` (`layer.ts:395`); sem clip nem
   máscara.
8. **Erros só de rede/console.** `errors()` agrega `pageerror`/HTTP≥400
   (`layer.ts:184-192`), não falhas de ação.

## Ordem de implementação sugerida

1. **Refs + snapshot com mapas** (itens 1, 2, 3): mudar o contrato de `SnapshotResult`
   para incluir `refs` e `xpathMap`; manter `tree` como texto compatível.
2. **Alvo único + `stale_ref`** (itens 4 e 10 da lista não priorizada): um campo
   `target` aceita `e12`, `css=`, `xpath=` e `role=...`; erro ensina o formato.
3. **Action loop** (itens 7 e 5): esperar estável/visível/habilitado, scroll alternado,
   hit-test, retry com backoff; só então clicar.
4. **Verificação** (itens 6 e verificação por role): segundo snapshot + diff, retorno
   `{ ok, changed, diff }`; `verify` separado de `act`.
5. **Segurança de contexto** (redação de sensíveis + limite de 40k): cortar senha,
   cartão e one-time-code antes de qualquer prompt.
6. **Sessão** (item 9): consolidar `auto | chrome-existing | playwright` em uma decisão
   única, com diagnóstico — hoje está espalhado em `chromeBackend()` e
   `requireChromeIfRequested()` (`layer.ts:86-97`).

## Licenças e reuso

Playwright e Puppeteer são Apache-2.0: uso como dependência é livre; trechos copiados
exigem aviso e `NOTICE`. browser-use e Stagehand são MIT: porta com copyright original.
Nenhum dos quatro impede reúso. O risco real é **acoplamento**: o runtime da extensão do
Stagehand e o protocolo do Playwright não são portáveis; o que se aproveita são
contratos, formatos de árvore e algoritmos de espera/resolução.

## Arquivos produzidos

- `docs/research/estudos/browser/browser-use--browser-use.md` (173 linhas)
- `docs/research/estudos/browser/microsoft--playwright.md` (168 linhas)
- `docs/research/estudos/browser/puppeteer--puppeteer.md` (151 linhas)
- `docs/research/estudos/browser/browserbase--stagehand.md` (174 linhas)
- `docs/research/estudos/browser/_RESUMO.md`
