# browser-use

| Campo | Valor |
|---|---|
| Repositório | https://github.com/browser-use/browser-use |
| Clone local | `repositorios/_research/browser/browser-use--browser-use` |
| Commit | `3df5806a0d097a1546d92c49bcf1b28c9972c3bd` (2026-10-22) |
| Licença | MIT (`LICENSE:1-3`) |
| Categoria | browser / agente de navegador + DOM serializer + CDP |
| Stack | Python ≥3.11, Pydantic v2, `cdp-use` 1.4.5 (CDP tipado), Click/TUI, `uv` |
| Tamanho | 417 fontes Python (~94 mil linhas); 126 arquivos de teste; versão 0.13.13 (`pyproject.toml:5`) |

## 1. O que é (verificado no código)

Não é um "wrapper de Playwright": fala CDP direto por `cdp-use` e constrói o próprio
snapshot do DOM (`browser_use/dom/service.py:403`). O produto é um agente que recebe uma
tarefa em linguagem natural e itera modelo → ação indexada → novo estado
(`browser_use/agent/service.py:2521`). O diferencial para nós não é o agente e sim a
**pipeline de serialização DOM→texto com índice estável por `backendNodeId`**
(`browser_use/dom/serializer/serializer.py:660-770`) e a **escada de reidentificação de
elemento** entre passos (`browser_use/dom/views.py:165` e `agent/service.py:3565-3617`).
O README fala de "cloud browsers"; o código local é inteiramente local + CDP.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `python -m browser_use` | `browser_use/__main__.py:5-10` | entrada do CLI (`cli.py:423` `main`) |
| `browser-use install` | `browser_use/cli.py:83` `_run_install_command` | instala/valida Chromium |
| `browser-use` (bare) | `browser_use/cli.py:185` `_run_browser_harness` | delega ao binário externo `browser-harness` |
| `python -m browser_use.mcp` | `browser_use/mcp/__main__.py` + `mcp/server.py:186` | servidor MCP com cerca de 16 tools |
| `Agent(task=..., llm=...).run()` | `browser_use/agent/service.py:2521` | superfície de biblioteca (não CLI) |
| `Browser.from_system_chrome()` | `browser_use/browser/session.py:446` | usa o Chrome e o perfil do usuário |

O CLI legado foi substituído: `cli.py:232` (`_legacy_command`) só emite mensagem de
migração. A superfície real hoje é a classe `Agent` + `Tools`, não subcomandos.

## 3. Arquitetura e fluxo

```
python -m browser_use → Agent.run (agent/service.py:2521)
  → step (service.py:1036) → LLM ainvoke → AgentOutput (lista de ações)
    → multi_act (service.py:2755) → Tools.act → evento (bubus)
      → DefaultActionWatchdog / DOMWatchdog (CDP)
        → DomService.get_serialized_dom_tree (dom/service.py:403)
          → DOMSnapshot.captureSnapshot + DOM.getDocument + Accessibility.getFullAXTree
            → DOMTreeSerializer (serializer.py:114) → texto com [índice]
```

- Entry point: `browser_use/__main__.py:5`; biblioteca em `browser_use/agent/service.py:2521`.
- Loop do agente: `agent/service.py:1036` (`step`) e `:1212` (`_execute_actions`).
- Execução de ferramenta: `agent/service.py:2755` (`multi_act`) → `browser_use/tools/service.py:441`.
- Streaming: **não encontrado**; a interface de modelo é `ainvoke`, sem `astream`
  (`browser_use/llm/base.py:50-55`).
- Persistência: `AgentHistoryList.save_to_file` (`agent/views.py:622`) e
  `StorageStateWatchdog` a cada 30 s (`browser/watchdogs/storage_state_watchdog.py:41`).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `click` (índice ou coordenada) | `tools/service.py:2128-2150` | clique por índice do snapshot ou x/y | médio |
| `input` | `tools/service.py:774` | digita em campo por índice | médio |
| `navigate` / `go_back` | `tools/service.py:502`, `:583` | navegação com `terminates_sequence` | médio |
| `search` | `tools/service.py:458` | busca em DuckDuckGo/Google/Bing | médio |
| `extract` | `tools/service.py:1067` | extração por LLM do markdown da página | alto (custo) |
| `search_page` | `tools/service.py:1307` | grep no texto, custo zero | baixo |
| `find_elements` | `tools/service.py:1344` | query CSS com atributos e texto | baixo |
| `evaluate` | `tools/service.py:1833` | JS arbitrário na página | **alto** |
| `screenshot` / `save_as_pdf` | `tools/service.py:1524`, `:1564` | captura/PDF | baixo |
| `read_file` / `write_file` / `replace_file` | `tools/service.py:1787-1795` | filesystem do agente | alto |
| `select_dropdown` / `dropdown_options` | `tools/service.py:1707`, `:1679` | `<select>` nativo | baixo |
| `done` / `structured_output` | `tools/service.py:2049`, `:2012` | encerra a tarefa | baixo |

## 5. Loop do agente, contexto e streaming

O prompt de sistema e o histórico são montados em `MessageManager`
(`agent/message_manager/service.py:104`). O estado da página entra como texto com
índices; o histórico tem dois cortes: `max_history_items` mantém o primeiro item + os
últimos N e insere "omitted" (`service.py:169-189`), e `compacted_memory` é prefixado
como `<compacted_memory>` (`service.py:153-163`). O snippet de elementos é limitado a
40 000 caracteres (`message_manager/service.py:122`).

Falha e retry: `consecutive_failures` é contado em `agent/service.py:1298-1303`;
`max_failures` default 5 (`:173`); ao estourar, força um `done` final
(`:1583-1589`). Erros de modelo têm retry separado (`:1668`) e fallback para outro
provedor só em `401/402/429/500/502/503/504` (`:1978-2003`). Ações em lote usam
`multi_act` com dois guardas contra DOM obsoleto: flag estática `terminates_sequence`
e comparação de URL/alvo antes/depois (`:2755-2763`).

## 6. Sessões, estado e persistência

`BrowserSession` é um `BaseModel` com perfil, `cdp_url`, `user_data_dir` e
`profile_directory` (`browser/session.py:141-273`). A sessão CDP é criada/retomada por
`get_or_create_cdp_session` (`:1498`), com timeout de conexão de 15 s (`:857-879`).
O mapa de elementos do último snapshot fica em `_cached_selector_map` e é trocado em
bloco por `update_cached_selector_map` (`:2530-2541`), indexado por
`(session_id, backend_node_id)` — não por posição no array.

Histórico: `AgentHistoryList` (`agent/views.py:590`) expõe `errors()`, `urls()`,
`screenshots()` e `final_result()` (`:704-802`), e serializa em JSON com filtro opcional
de dados sensíveis (`:622-630`). Cookies/localStorage vão para `storage_state.json`
automaticamente (`browser/watchdogs/storage_state_watchdog.py:41-56`).

## 7. Configuração e extensibilidade

Config por ambiente (`browser_use/config.py:47-117`): `BROWSER_USE_CONFIG_DIR`,
`BROWSER_USE_EXTENSIONS_DIR`, perfil default em `profiles/default`. Ferramentas são
plugins: `@tools.action(description, param_model=..., terminates_sequence=...)`
(`tools/registry/service.py:291-304`), com `allowed_domains` por ferramenta. O registry
injeta parâmetros especiais por **nome** (`browser_session`, `file_system`), o que é uma
armadilha documentada no próprio código (`registry/service.py:57-75`). Há integrações
OpenAI/Anthropic (`browser_use/integrations/openai/browser_use.py`), MCP
(`mcp/server.py:186`) e skills (`browser_use/skills/service.py`).

## 8. Permissões, sandbox e erros

Domínios: `SecurityWatchdog` bloqueia navegação fora de `allowed_domains` e dentro de
`prohibited_domains` (`browser/watchdogs/security_watchdog.py:35-44`, `:176-239`).
Campos sensíveis: `password`, `file`, `hidden` e `autocomplete=cc-*`/`one-time-code`
têm o valor descartado antes de virar árvore (`dom/enhanced_snapshot.py:46-67`, aplicado
em `:125`). Downloads e PDF têm watchdog próprio. Execução remota existe como decorator
`@sandbox` que serializa a função e roda no serviço deles (`sandbox/sandbox.py:215-267`)
— não é isolamento local.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| CI de ações | `tests/ci/test_action_*.py` | blank page, timeout, loop, PDF, storage |
| DOM | `tests/ci/test_dom_paint_order_serialization.py`, `test_dom_visibility.py` | paint order e visibilidade |
| Matching | `tests/ci/test_ax_name_matching.py` | fallback por nome acessível |
| Sessão/CDP | `tests/ci/test_browser_session.py`, `test_cdp_timeout.py` | ciclo de vida e timeout |
| Total | 126 arquivos `*.py` em `tests/` | — |

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Escada de identidade do elemento (EXACT → STABLE → XPATH → AX_NAME → ATTRIBUTE) | `dom/views.py:165-185` + `agent/service.py:3565-3710` | resolve "elemento sumiu entre dois snapshots", problema central do nosso loop | MIT | `src/core/browser/element-identity.ts` | 24 |
| Snapshot híbrido DOMSnapshot + AX + paint order + bbox | `dom/service.py:403-660`, `serializer/serializer.py:114-165` | remove o que está atrás de modal e numera só o interativo | MIT | `src/core/browser/snapshot/` | 22 |
| Índice = `backendNodeId` com síntese sem colisão | `serializer/serializer.py:637-770` | índice estável entre rebuilds, sem renumerar 1..N | MIT | `src/core/browser/element-ref.ts` | 22 |
| Clique com hit-test/occlusão e eventos CDP reais | `browser/watchdogs/default_action_watchdog.py:574-620`, `:703-942` | evita "cliquei no overlay"; nosso `click` só chama Locator | MIT | `src/core/browser/actions.ts` | 21 |
| Redação de campos sensíveis no snapshot | `dom/enhanced_snapshot.py:46-67` | impede senha/cartão vazarem no prompt | MIT | `src/core/browser/redact.ts` | 20 |
| `ActionResult` estruturado (conteúdo, erro, memória, done) | `agent/views.py:307-380` | contrato único de retorno de ferramenta | MIT | `src/core/browser/result.ts` | 18 |
| Dica de conteúdo escondido em iframe ("N páginas abaixo") | `dom/service.py:80-180` | reduz scroll cego do modelo | MIT | `src/core/browser/snapshot/hints.ts` | 17 |
| Guarda de sequência por mudança de URL/alvo | `agent/service.py:2755-2763` | impede ação em lote sobre DOM que já mudou | MIT | `src/core/browser/batch-guard.ts` | 16 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Agente/LLM e 15 provedores (`browser_use/llm/*`) | já temos roteador próprio; custo de manter é alto |
| `@sandbox` / browser cloud | depende do serviço comercial deles |
| CLI + TUI (`cli.py`) | o CLI foi terceirizado para `browser-harness`; não temos esse produto |
| `evaluate` como ferramenta default | executa JS arbitrário; nosso modelo de permissão é mais restrito |
| Motor CDP em Python | stack incompatível; portar conceito, não código |

## 12. Modelo de exemplo para o nosso harness

Copiar o **contrato de referência**, não o agente:

1. `snapshot()` devolve `{ url, title, tree, refs: Map<string, ElementHandleInfo> }`.
   Cada linha interativa vira `[e12] button "Salvar"`; `e12` é derivado do
   `backendNodeId`, como em `serializer.py:755`.
2. `click({ ref })` resolve por `ref` primeiro; `{ role, name }`, `{ text }` e
   `{ selector }` são fallbacks declarados, na ordem de `agent/service.py:3565-3710`.
3. Se a resolução falhar, o retorno é tipado (`stale_ref` vs `not_found` vs
   `not_visible`) e o chamador decide re-snapshot — não repetir o clique às cegas.
4. Após cada ação, comparar URL + título + hash do snapshot; se mudou, invalidar refs
   (equivalente ao guard de `multi_act`).
5. Nosso `src/core/browser/layer.ts` hoje faz `ariaSnapshot` (`layer.ts:323`) com
   fallback para `innerText`, e `locate()` só aceita selector/role/text
   (`layer.ts:419-429`), sem refs e sem verificação. O ganho começa em trocar o texto
   livre por linhas com ref e em cortar o `waitForTimeout(250)` de `click`
   (`layer.ts:340`).

Teste: subir uma página com modal sobreposto, dois botões iguais e um campo
`type=password`; exigir que o snapshot não mostre o valor, que o clique atinja o botão
do modal e que o ref continue válido após um re-render que não troque o nó.

## 13. Evidências da análise

```text
git -C browser-use--browser-use rev-parse HEAD
  3df5806a0d097a1546d92c49bcf1b28c9972c3bd

pyproject.toml:5        version = "0.13.13"
pyproject.toml:41-44    "cdp-use==1.4.5", requires-python ">=3.11,<4.0"

agent/service.py:2521   async def run(self, max_steps: int = 500, ...)
agent/service.py:1036   async def step(...)
agent/service.py:2755   async def multi_act(...)  # page-change guards
agent/service.py:1298   max_total_failures = self.settings.max_failures + ...
agent/views.py:307      class ActionResult(BaseModel)
agent/views.py:622      def save_to_file(...)

dom/service.py:403      async def _get_all_trees(...)
dom/service.py:570-585  DOMSnapshot.captureSnapshot(includePaintOrder=True) + DOM.getDocument(depth=-1, pierce=True)
dom/serializer/serializer.py:114  serialize_accessible_elements
dom/serializer/serializer.py:755  node.selector_index = self._allocate_selector_index(...)
dom/views.py:165        class MatchLevel(Enum)  # EXACT/STABLE/XPATH/AX_NAME/ATTRIBUTE
dom/enhanced_snapshot.py:48  _SENSITIVE_INPUT_TYPES = {'password','file','hidden'}

browser/watchdogs/default_action_watchdog.py:703  _click_element_node_impl
browser/watchdogs/default_action_watchdog.py:877  is_occluded = await self._check_element_occlusion(...)
browser/watchdogs/security_watchdog.py:176        def _is_url_allowed(...)

Get-ChildItem tests -Recurse -Filter *.py | Measure-Object  → 126
Get-ChildItem browser_use -Recurse -Filter *.py | Measure-Object -Line → ~93.965 linhas
```
