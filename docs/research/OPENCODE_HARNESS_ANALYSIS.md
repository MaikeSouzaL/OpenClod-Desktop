# Análise do harness do OpenCode e o que portar para o Openclod

> **Objeto analisado:** `sst/opencode`, commit `20a6cc72917586eb5314be075f96dbb21d16c480`
> (24/10/2026), pacote `@opencode/core` versão **2.1.4**, licença **MIT**.
> O clone de `sst/opencode` entrega o código atual; o README e o `package.json` apontam
> para `anomalyco/opencode`. Clone em `%TEMP%\opencode-repo` (somente leitura; o
> repositório do Openclod não foi alterado).
>
> **Método:** leitura direta do código de `packages/core`, `packages/ai`, `packages/plugin`,
> `packages/plugin-browser`, `packages/gui-extensions`, `packages/desktop` e `packages/cli`.
> Todas as citações `arquivo:linha` se referem a esse commit. O OpenCode v2 foi reescrito
> sobre Effect e tem pouca semelhança estrutural com o v1; o valor está nas **decisões de
> arquitetura e nos protocolos**, não em copiar arquivos.
>
> **Legenda:** caminhos sem prefixo são do repositório do OpenCode. Caminhos `src/...` são
> do Openclod (`C:\Users\Administrator\Desktop\Openclaudedescktop`). Citações curtas como
> `runner/llm.ts`, `tool/...`, `permission/...` são relativas a `packages/core/src/`;
> `schema/...` é `packages/schema/src/...`; `config/plugin/...` é
> `packages/core/src/config/plugin/...`.
>
> A licença MIT permite reutilizar ideias e trechos com atribuição. As propostas abaixo
> assumem **reimplementação** no estilo do Openclod, não cópia de arquivos.

---

## Resumo executivo

1. O OpenCode **não tem Computer Use de sistema operacional**. O que ele chama de browser
   tools é automação de abas Chromium via CDP, exposta ao modelo como ferramentas
   `browser.*` e executada no processo desktop por RPC. Não há mouse/teclado global,
   captura de tela fora do Chromium nem ferramentas de janela do Windows.
2. Apesar disso, o **modelo de interação** do browser é o melhor material para o Computer
   Use do Openclod: refs de elemento com geração, invalidação explícita, mensagens de erro
   que ensinam a recuperação, verificação de estado e a regra “o resultado é desconhecido;
   inspecione antes de repetir”.
3. O loop do OpenCode separa **turno → passo lógico → tentativa de provedor**. Retry,
   compactação e continuação não criam novos passos; isso mantém o log durável e a UI
   coerentes. O Openclod hoje mistura iteração, tentativa e retry no mesmo laço.
4. A decisão de continuar é explícita: `needsContinuation` é verdadeiro quando alguma
   ferramenta local foi chamada/executada, não quando o provedor devolve `stop`. Isso evita
   encerrar com ferramentas pendentes.
5. O tratamento de “não” em permissões é fino: **recusar sem motivo encerra o passo**;
   **recusar com feedback vira erro de ferramenta e o modelo continua**. Isso impede o
   modelo de contornar uma negativa e, ao mesmo tempo, permite correção.
6. O OpenCode tem um **motor de regras por recurso** (`ação + recurso + efeito`, último
   match vence), aprovações salvas por projeto, aprovação em lote e parsing de shell por
   comando. O Openclod tem regras por string no estilo Claude Code e decisão por modo.
7. A compactação do OpenCode é mais sofisticada: reserva 15%/16k tokens, mantém 15k
   verbatim, mede tokens pelo usage real do provedor, pré-calcula o resumo em background a
   85% e só o troca quando a compactação é devida, além de validar o template e dar um
   “nudge” quando o modelo não o segue.
8. O OpenCode **não faz fallback de modelo**. Ele repete o mesmo modelo com política de
   retry (2s→10s, até 10 retries, jitter, `Retry-After` limitado a 15 min, no máximo 3
   retries de timeout). O Openclod já tem fallback (`MAX_MODEL_FALLBACKS = 8`, quando
   `useAllModels` está ligado), então aqui estamos à frente; o que vale portar é a política
   de retry e a continuação de stream.
9. Em MCP, o OpenCode tem OAuth completo (loopback 127.0.0.1, PKCE, state, DCR/CIMD,
   credencial persistida), máquina de estados (`pending/connected/failed/needs_auth/disabled`),
   reconexão em sessão expirada, `tools/list_changed`, timeouts separados e instruções do
   servidor injetadas no prompt. O Openclod tem auto-instalação pelo registro MCP (à frente),
   mas não tem OAuth, reconexão nem status individual.
10. O OpenCode **não tem plugin sandbox**: plugins são `import()` no mesmo processo, com
    acesso ao host; a única defesa é política gerenciada (`plugin:<target>`) e revisão.
    Para o Openclod, um sistema de plugins só vale a pena com API restrita e isolamento.

---

## 1. Mapa do repositório e fluxo do agente

### 1.1 Onde está cada coisa

| Área | Pacote | Arquivos-chave |
|---|---|---|
| Loop e sessão | `packages/core/src/session` | `runner/llm.ts`, `runner/step.ts`, `compaction.ts`, `context.ts`, `inbox.ts`, `subagent-job.ts` |
| Ferramentas | `packages/core/src/tool` | `runtime.ts`, `plugin/*.ts`, `mcp.ts` |
| Permissões | `packages/core/src` | `permission.ts`, `file-access.ts`, `shell/parse.ts`, `managed-policy.ts` |
| MCP | `packages/core/src/mcp` | `client.ts`, `index.ts`, `oauth.ts`, `stdio.ts` |
| Skills | `packages/core/src/skill` + `config/plugin` | `discovery.ts`, `instructions.ts`, `skill-file.ts`, `skill-scan.ts` |
| Plugins | `packages/core/src/plugin` + `packages/plugin` | `module.ts`, `supervisor.ts`, `hooks.ts`, `effect/*` |
| Abstração de LLM | `packages/ai` | `route/*`, `providers/*`, `protocols/*` |
| Browser/Computer Use | `packages/plugin-browser`, `packages/gui-extensions/src/browser` | `rpc.ts`, `tools.ts`, `connection.ts`, `chromium.ts`, `refs.ts` |
| Desktop | `packages/desktop` | Electron, IPC, painel de browser, extensões |
| CLI/Server/Client | `packages/cli`, `packages/server`, `packages/client` | `mcp add`, `mcp auth`, HTTP API |

### 1.2 Fluxo de um turno

```
SessionRunner.drain
  └─ advanceToStep        (inbox: input/steer/compaction/move)
      └─ prepareContext   (plugin activation, agente, instruções, tools snapshot)
      └─ runStep          (passo lógico; assistente/step IDs)
          └─ compaction.compact (auto/overflow, opcional)
          └─ model-request.primary (system + histórico + definições)
          └─ SessionStep.attempt (uma tentativa de provedor)
              ├─ stream do provedor
              ├─ executa tool calls em fibers paralelas
              └─ devolve Outcome (Completed/Retry/Continue/Compacted/...)
```

Citações: `packages/core/src/session/runner/llm.ts:56-194` (drain), `:206-338` (runStep),
`packages/core/src/session/runner/step.ts:52-101` (uma tentativa), `:104-300` (stream e
settlement).

O detalhe importante é que `runStep` **não** reinicia o passo a cada retry: ele reusa o
mesmo `assistantMessageID` e só o troca em compactação, continuação de output ou stream
interrompido com output (`runner/llm.ts:208-221`, `:290-335`). O Openclod hoje usa `iteration` como
unidade de tudo (`src/core/agent/runner.ts:661-707`), o que dificulta distinguir “tentativa
que falhou” de “passo que produziu efeitos”.

### 1.3 O que vale portar

- **Modelo de três níveis** (`turn`, `step`, `attempt`) com IDs estáveis. Impacto em log,
  retomada, UI e contabilização de custo.
- **Eventos duráveis** de início/fim de passo e de ferramenta, com settlement explícito
  (`Step.Started`, `Step.Ended`, `Tool.Called`, `Tool.Success`, `Tool.Failed`). O OpenCode
  trata ferramenta não liquidada no boot (`runner/llm.ts:371-394`) — o Openclod não tem essa
  recuperação.
- **Inbox durável** com `steer`/`queue` (seção 3.6).

---

## 2. Computer Use e desktop

### 2.1 O que o OpenCode realmente implementa

**Não existe Computer Use de sistema operacional.** A busca por `nut.js`, `robotjs`,
`xdotool`, `osascript`, `SendInput`, `CGEvent` e `enigo` em `packages/` não retorna
dependência de automação de desktop. O que existe é:

- `packages/gui-extensions/src/browser/chromium.ts`: uma aba Electron com CDP anexado,
  árvore de acessibilidade, screenshots, cliques, digitação, formulários, upload, console,
  rede, trace, CPU e heap.
- `packages/plugin-browser`: transforma cada operação em uma ferramenta `browser.*` e a
  encaminha por RPC ao processo desktop (`packages/plugin-browser/src/tools.ts:12-53`).
- `packages/desktop`: hospeda o painel e faz a ponte; não há captura/ação fora do Chromium.

Ou seja: o “desktop” do OpenCode é um **navegador embutido**, não a área de trabalho. Isso
precisa ficar explícito na comparação; o Openclod, via `open-computer-use`, está à frente em
cobertura (UI Automation + Win32 + mouse/teclado reais).

### 2.2 Superfície de ferramentas do browser

As operações são declaradas como schemas em `packages/plugin-browser/src/rpc.ts:160-330` e
viram ferramentas com namespace e permissão próprios:

```ts
// packages/plugin-browser/src/tools.ts:41-53 (resumido)
editor.namespace({ name: "browser", description: "..." })
Browser.Operations.forEach((operation) => {
  editor.add({
    name: operation.name.slice(separator + 1),
    options: { namespace: ..., permission: "browser", codemode: true },
    execute: (input, tool) => execute(operation, { ...input, type: operation.name }, tool),
  })
})
```

Por padrão essas ferramentas entram no catálogo do **Code Mode** (`codemode: true` em
`tools.ts:47`), então o modelo as chama dentro de `execute`; um agente pode recebê-las
diretamente se o plugin optar por `codemode: false`.

Operações disponíveis (nomes reais):

| Grupo | Operações |
|---|---|
| Abas | `tabs.list`, `tabs.open`, `tabs.focus`, `tabs.close` |
| Navegação | `navigate`, `back`, `forward`, `reload`, `stop`, `frames` |
| Leitura | `snapshot`, `find`, `evaluate`, `console`, `network.list`, `network.get` |
| Interação | `click`, `hover`, `drag`, `fill`, `fill_form`, `select`, `check`, `press`, `scroll`, `wait` |
| Captura | `screenshot`, `preview` |
| Diálogos/arquivos | `dialog`, `files.upload`, `files.drop`, `files.list`, `files.get` |
| Diagnóstico | `trace.start/stop/analyze`, `cpu.start/stop/analyze`, `heap.snapshot/summary/query/object/compare` |

Pontos de design que valem ouro:

1. **Toda operação de página exige `tabID` explícito** (`rpc.ts:32-35`). Foco não
   seleciona alvo.
2. **Refs de elemento** (`@e1`, `@e2`, ...) vêm do snapshot de acessibilidade; não são
   índices posicionais e expiram a cada snapshot/navegação (`rpc.ts:25-28`,
   `chromium.ts:1443-1519`).
3. **Geração da aba**: cada navegação incrementa `generation`; a ação carrega a geração e o
   desktop recusa se ela mudou (`chromium.ts:295-310`, `:316-327`, `:618-627`).
4. **Snapshot é limitado** (profundidade 8, 500 linhas, nomes truncados em 300 chars,
   `truncated: true`) e inclui flags `checked/disabled/expanded/selected` e, opcionalmente,
   `box` (`chromium.ts:1453-1519`).
5. **Screenshot** retorna imagem + arquivo no servidor, exige aba focada e janela visível,
   e falha com mensagem específica quando não há frame renderizado (`chromium.ts:929-975`).
6. **Espera por condição**, não por sleep: `load`, `text`, `textGone`, com timeout limitado
   a 30s (`rpc.ts:310-315`).
7. **Dados de página são não confiáveis** e isso aparece na descrição da ferramenta e no
   conteúdo retornado (`tools.ts:56-58`, `:89-99`).
8. **Transferência de arquivos tem limite de 5 MiB** (`rpc.ts:10-12`) e mensagem que
   proíbe repetir capture idêntico (`files.ts:67`).
9. **Timeout e desconexão produzem “resultado desconhecido”**, com instrução explícita de
   inspecionar antes de repetir ação mutável (`connection.ts:203-251`).
10. **Permissão `browser` é negada por padrão** em todos os agentes e só é concedida à
    sessão enquanto o desktop está anexado (`connection.ts:24-53`, `:85-105`). A concessão
    não é um “ask” por chamada: ela inclui ou remove as ferramentas do catálogo
    (`whollyDisabled` em `tool.ts:293-296`); sem a regra, a ferramenta nem aparece para o
    modelo.

O ciclo recomendado é **dirigido pelo modelo**, não por um verificador separado:
`tabs.list`/`tabs.open` → `tabs.focus` → `snapshot` (obtém refs) → `click`/`fill`/`press`
→ `wait` por `load`/`text` → novo `snapshot` (ou `screenshot`). Cada `snapshot` invalida
os refs anteriores; cada navegação incrementa a geração. Se a ação não produz a mudança
esperada, o modelo deve reler o estado e mudar de abordagem, não repetir o mesmo clique
(`rpc.ts:300-328`; `chromium.ts:1164-1170`).

### 2.3 Como o desktop e o servidor conversam

O plugin registra handlers RPC `attach`, `state`, `command`, `result` e túneis
(`connection.ts:76-158`). O anexo é **por sessão**:

- `attach` valida que a sessão pertence ao mesmo `location.directory`
  (`connection.ts:79-84`);
- cada anexo substitui o anterior e fecha o antigo (`:85-105`);
- a sessão recebe uma regra temporária `browser:* allow`, removida no detach
  (`:29-53`);
- ações concorrentes são correlacionadas por `requestID` e podem ser canceladas
  (`:203-251`).

O comando leva `generation` da aba e arquivos como **bytes** (não caminhos), porque
servidor e desktop podem estar em máquinas diferentes (`:213-220`; `rpc.ts:338-349`).

### 2.4 O que o Openclod já tem e onde está o gap

O Openclod tem um Computer Use real: `src/core/computer/layer.ts` mantém um processo
`open-computer-use mcp`, usa UI Automation e Win32, converte coordenadas da screenshot para
a tela (`layer.ts:84-97`), mantém um `lastCapture` e refaz o snapshot quando o backend
perde estado (`layer.ts:195-206`). As ferramentas estão em `src/core/tools/computer.ts`:
`computer_snapshot`, `computer_click`, `computer_set_value`, `computer_type_text`,
`computer_press_key`, `computer_scroll`, `computer_drag`, `computer_wait`,
`computer_wait_for`, entre outras (`:542-560`).

Gaps concretos:

| Gap | Hoje | Efeito |
|---|---|---|
| Sem geração/ref estável | `element_index` é um número; um novo snapshot pode reordenar | Modelo clica no elemento errado após mudança de tela |
| Verificação não é automática | O prompt manda verificar (`src/core/agent/context.ts:50-55`) | Modelo pode clicar e concluir sem reler o estado |
| Erros genéricos | `layer.call` devolve `open-computer-use/<tool>: ...` (`layer.ts:186-193`) | Modelo não sabe se pode repetir, se o elemento sumiu ou se a janela fechou |
| Sem “resultado desconhecido” | Timeout vira erro comum | Modelo repete clique/ação que pode ter executado |
| Controle global | `policy.allowComputerControl` é global (`src/core/tools/computer.ts:6-11`) | Uma vez ligado, vale para todas as sessões |
| Sem dono de janela | Duas sessões podem agir na mesma janela | Agentes paralelos brigam pelo foco |
| Snapshot sem orçamento | Texto pode ser enorme | Contexto estourado em árvores grandes |

### 2.5 Proposta de adaptação ao Openclod (Computer Use)

**P0 — Refs + geração + invalidação**

Adicionar ao `ComputerLayer` um `snapshotId` incremental e um mapa `ref -> element_index`
por snapshot. As ferramentas passam a aceitar `element_ref` (`e12`) e `snapshot_id`; se o
`snapshot_id` não for o atual, devolver erro estruturado com a instrução de tirar novo
snapshot. Manter `element_index` como compatibilidade, mas não anunciá-lo no schema.

```ts
// proposta (não implementada)
type SnapshotRef = { snapshotId: number; windowId: number; ref: string; index: number }
// ComputerLayer.snapshot() incrementa snapshotId e reconstrói o mapa
// computer_click({ window, ref, snapshot_id }) valida snapshot_id antes de agir
```

**P0 — Verificação pós-ação embutida**

Após `click`, `type`, `press`, `set_value`, `drag`, `scroll`, a ferramenta deve:
1. capturar um hash da árvore de acessibilidade antes;
2. aguardar até N ms por mudança (ou usar `computer_wait_for` internamente);
3. devolver `changed: true|false`, um diff curto (linhas adicionadas/removidas) e um novo
   `snapshot_id`;
4. se nada mudou, devolver `changed: false` com instrução para não repetir o mesmo clique.

Isso transforma a regra “verifique o estado após cada ação”, hoje só no prompt, em
comportamento do harness. É a maior melhoria de confiabilidade do Computer Use. O
`BrowserLayer` do Openclod já faz algo parecido: `browser_click` e `browser_type` tiram um
novo snapshot e o devolvem ao modelo (`src/core/tools/browser.ts:101-105`, `:136-138`); o
Computer Use deveria seguir o mesmo contrato.

**P0 — Taxonomia de erro e “outcome unknown”**

Mapear erros do backend para códigos estáveis e textos de recuperação, no espírito de
`packages/gui-extensions/src/browser/errors.ts:3-49`:

| Código | Quando | Instrução ao modelo |
|---|---|---|
| `window_gone` | janela fechou | listar janelas e reescolher |
| `element_stale` | ref de snapshot antigo | novo snapshot, novo ref |
| `element_disabled` | UIA reporta disabled | inspecionar por que está desabilitado |
| `secure_desktop` | UAC/tela segura | pedir ao usuário; não tentar contornar |
| `capture_failed` | GDI falhou | focar janela, verificar visibilidade; não repetir igual |
| `timeout_outcome_unknown` | ação pode ter executado | inspecionar estado antes de repetir |
| `disconnected` | backend caiu | reconectar e listar janelas; ação pode ter executado |

**P1 — Orçamento de snapshot e screenshot**

- Limitar a árvore a ~500 linhas e profundidade ~8, marcando `truncated`.
- Salvar screenshots grandes em arquivo e devolver caminho + imagem reduzida; nunca
  embutir base64 sem limite no histórico.
- Adicionar orçamento de imagens por requisição (ver 3.4): 25 MiB de gatilho, 15 MiB de
  alvo, substituindo as mais antigas por texto.

**P1 — Dono de janela por sessão**

Um `Map<sessionId, Set<windowId>>` com lease: a primeira sessão que age numa janela vira
dona até liberar/trocar de janela; outra sessão recebe `window_busy`. Isso evita dois
subagentes disputando o mesmo formulário.

**P1 — Concessão efêmera + indicador**

Manter `allowComputerControl` global como “kill switch”, mas exigir uma concessão por
sessão (equivalente ao `browser:* allow` temporário do OpenCode) e mostrar o overlay
enquanto a concessão estiver ativa (`src/main/computer-overlay.ts` já existe). O usuário vê
exatamente quando o agente pode controlar o mouse/teclado.

---

## 3. Loop do agente

### 3.1 Continue/stop: a regra explícita

O OpenCode não decide continuar **apenas** pelo `finish_reason`. Ele agrega o que
aconteceu no passo e usa o finish reason para casos específicos (limite de output):

```ts
// packages/core/src/session/runner/publish-llm-event.ts:645-654
needsContinuation: Iterable.some(
  tools.values(),
  (tool) => !tool.providerExecuted && (tool.called || tool.settled),
)
```

Se houve ferramenta local chamada ou liquidada, o passo precisa de continuação; se não,
o turno termina. O `runStep` então retorna `needsContinuation` e o `drain` decide se chama
outro passo (`runner/llm.ts:275-337`). Isso é mais robusto do que olhar `finish_reason`, porque o
provedor pode devolver `stop` com tool calls pendentes ou `tool_calls` sem execução.

**Portar:** formalizar `needsContinuation` no `SessionRunner` do Openclod, calculado a
partir de `toolCalls.length` + resultados efetivamente liquidados, e não do `stopReason`
atual (`src/core/agent/runner.ts:850-876`). O comportamento é parecido, mas explícito
facilita retomada e testes.

### 3.2 Limite de output e continuações

- Máximo de **2 continuações** após `finish === "length"`; na terceira resposta truncada
  consecutiva, falha com `output-limit` (`runner/llm.ts:299-328`).
- Cada continuação é uma mensagem sintética: “sua resposta anterior foi cortada; continue
  sem repetir; quebre o restante em partes menores” (`runner/llm.ts:37-38`).
- O passo final de um agente com `steps` definido mantém as **definições de ferramentas**
  (para preservar o prefixo do cache), mas envia `toolChoice: "none"` e um prompt
  `MAX_STEPS_PROMPT` que proíbe ferramentas e pede resumo (`runner/llm.ts:224-243`;
  `runner/max-steps.ts:1-16`).

O Openclod já tem `MAX_LENGTH_CONTINUATIONS = 2` (`src/core/agent/runner.ts:58`), o prompt
final (`:81-82`) e `toolChoice: 'none'` no último passo (`:678-693`). Gap: após duas
tentativas, o Openclod apenas marca `stopReason = 'length'`; o OpenCode falha com erro
explícito. Vale alinhar para o usuário saber que o resultado está incompleto.

### 3.3 Retry, erros e “fallback”

**Retry do OpenCode** (`packages/core/src/model-retry.ts:11-59`):

- backoff exponencial de 2s, limitado a 10s por gap, com jitter;
- até 10 retries (cerca de 84s de espera no pior caso);
- `Retry-After` do provedor respeitado, mas **limitado a 15 minutos**;
- no máximo **3 retries de timeout**, porque uma tentativa que já esperou minutos não pode
  segurar o turno por quase uma hora;
- hook de plugin pode ajustar o delay (`runner/retry.ts:35-54`).

**Continuação de stream interrompido** (`runner/step.ts:236-246`):

- se **nada** foi emitido, `RecoverFull` refaz a requisição inteira;
- se **algo** já foi emitido e o stream caiu, `Continue` mantém o output e injeta
  “a resposta anterior foi interrompida; continue de onde parou” (`runner/llm.ts:290-298`);
- isso evita duplicar texto já mostrado ao usuário.

**Fallback de modelo: o OpenCode não tem.** A busca por fallback em `packages/core/src`
encontra apenas fallback de seleção de agente, de rota WebSocket→HTTP
(`packages/ai/src/protocols/open-responses.ts:195-219`) e de valores de configuração. Não
há cadeia “modelo A falhou → modelo B”. O Openclod tem
`MAX_MODEL_FALLBACKS = 8` e troca de provedor em `quota/rate_limit/overloaded/auth/
bad_request/server/network/timeout` quando `useAllModels` está ligado
(`src/core/agent/runner.ts:66-77`, `:797-813`; `src/main/orchestrator.ts:248`).

**Recomendação para o Openclod:** manter o fallback (é um diferencial), mas:
- não trocar de modelo em `auth` e `bad_request` — são erros de configuração do provedor
  atual e a troca esconde o problema;
- persistir no `SessionMeta` qual modelo está ativo e por quê, para a UI não mentir;
- adicionar circuit breaker por provedor (após N falhas, pular para o próximo sem esperar
  o timeout cheio);
- portar `Retry-After`, jitter, limite de 15 min e limite de retries de timeout.

### 3.4 Orçamento de output e imagens

O OpenCode calcula `max_tokens` dinamicamente:

```ts
// packages/core/src/session/model-request.ts:47-90 (resumido)
requested = min(limit.output || 32_000, 256_000)
room = context - inputMeasured - ceil(inputEstimated * 1.15)
maxTokens = min(requested, max(1_024, room))
```

Isso evita pedir 8k de output quando o prompt já ocupou quase toda a janela. O Openclod
usa `config.maxOutputTokens` estático (`src/core/providers/openai.ts:157-158`,
`src/core/providers/anthropic.ts:125-149`). **Portar a fórmula** é barato e reduz
`context_overflow`.

O OpenCode também limita imagens inline: gatilho de 25 MiB, alvo de 15 MiB; ao passar do
gatilho, remove as imagens mais antigas e as substitui por um texto explicando que foram
removidas e que o modelo não deve afirmar nada sobre elas (`model-request.ts:42-45`,
`:181-209`). O Openclod, que captura telas o tempo todo, precisa disso com urgência.

### 3.5 Compactação

O OpenCode tem a compactação mais elaborada dos dois:

- **Reserva:** 15% da janela, no mínimo 16k tokens, para a resposta e para o resumo
  (`compaction.ts:118-132`).
- **Tail verbatim:** 15k tokens de conversa recente ao lado do resumo (`:253-261`); o
  corte é ajustado para não separar `tool_call` de `tool_result` (`:954-999`).
- **Medição:** usa o `usage` real da última resposta como âncora e estima só o que veio
  depois (`:1072-1098`). O Openclod estima por caracteres (`src/core/agent/compaction.ts:21-25`),
  o que erra bastante em código e em imagens.
- **Pré-cálculo em background:** a 85% do teto, com pelo menos 64k tokens medidos, começa
  um resumo em background; ele é **segurado** e só entra quando a compactação é devida
  (`:321-349`). Isso tira a latência do resumo do caminho crítico.
- **Validação do template:** o resumo precisa conter ao menos um heading do template; se
  não, um “nudge” é enviado uma vez; se ainda falhar, a compactação falha (`:159-198`,
  `:233-234`, `:452-484`).
- **Escada de shrink:** se o provedor rejeitar por tamanho, as tentativas seguintes miram
  85%, 70%, 50% e 35% do primeiro request rejeitado (`:120`, `:570-650`).
- **Modelo separado:** existe um agente `compaction` (builtin, oculto) que pode ter modelo
  próprio; se não, usa o modelo da sessão (`:264-282`; `plugin/agent.ts:96-100`).

O Openclod já copiou a ideia do template e do tail (`src/core/agent/compaction.ts:52-96`,
`:137-186`), mas:
- compacta de forma síncrona no meio do turno;
- usa estimativa por caracteres;
- não valida o resumo;
- não tem modelo separado;
- não tem pré-cálculo;
- não tem escada de shrink.

**Proposta P1:** implementar `precompute` (disparar resumo a ~80% e guardar), usar
`usage` real como âncora, validar headings com nudge, e permitir `compactionModel` na
configuração. É a melhoria de maior impacto para tarefas longas e para custo.

### 3.6 Inbox durável: `steer` e `queue`

O OpenCode aceita entrada do usuário enquanto o agente trabalha, com duas entregas:

- `queue`: entra no próximo turno;
- `steer`: é promovida no próximo limite de passo e altera o trabalho em andamento
  (`packages/schema/src/session-inbox.ts:11`, `:37-49`;
  `packages/core/src/session/inbox.ts:44-49`).

O inbox também carrega **controles**: `compaction` e `move` (mudança de workspace). Tudo é
serializado por sessão (`inbox.ts:59-63`) e persistido no SQLite, então sobrevive a
reinício.

O Openclod hoje rejeita `send` quando `busy` (`src/core/agent/runner.ts:608-610`). **Portar
o inbox é P0 de UX**: o usuário poder corrigir o agente no meio de uma tarefa longa sem
cancelar e sem perder o trabalho, e o agente vê a correção no próximo passo.

### 3.7 Ferramentas não liquidadas após crash

No boot de uma sessão, o OpenCode varre mensagens de assistant com ferramentas em
`streaming`/`running` e publica `Tool.Failed` com “Tool execution interrupted”
(`runner/llm.ts:371-394`). Também liquida compactações órfãs (`:341-369`).

O Openclod persiste o transcript, mas não tem essa varredura. Se o app cair no meio de uma
ferramenta, a UI pode mostrar um spinner eterno. **P1 barato:** no `ensureRunner`, varrer
`state.messages` e marcar `tool_call` sem `tool_result` como falho/abortado.

---

## 4. Agentes e subagentes

### 4.1 Modelo de agente

`packages/schema/src/agent.ts:23-35` define:

```ts
{
  id, name, model?, request, system?, description?,
  mode: "subagent" | "primary" | "all",
  hidden, color?, steps?, permissions: Ruleset
}
```

O default de um agente sem configuração é **allow em tudo**, com `ask` para arquivos
`.env` (`schema/agent.ts:39-52`). O ruleset “deny all” (`permission.ts:19`) só entra quando
o agente **não é resolvido** (`agent?.permissions ?? missingAgentPermissions`,
`permission.ts:145-150`); um agente existente sempre carrega o ruleset default acima.

Agentes em markdown são descobertos em `{agent,agents}/**/*.md` e `{mode,modes}/*.md`,
com hot reload por watcher e debounce de 100ms (`config/plugin/agent.ts:21-33`, `:56-82`,
`:178-217`). Campos aceitos incluem `model`, `variant`, `request.headers`,
`request.body`, `system`, `description`, `mode`, `hidden`, `color`, `steps`,
`permissions`, `disabled` (`:95-128`). O prompt é o corpo do markdown; `mode/` força
`primary` (`:213-216`).

Builtins: `build` (default), `general`, `explore`, `plan`, `compaction`, `title`,
`summary` (`plugin/agent.ts:55-116`; `plugin/plan.ts:12-42`). `explore` é deny-all e
allow explícito para `shell`, `read`, `grep`, `glob`, `webfetch`, `websearch` — um exemplo
limpo de menor privilégio (`plugin/agent.ts:74-94`).

### 4.2 Ferramenta `subagent`

O schema (`tool/plugin/subagent.ts:29-48`) aceita:

- `agent`: nome do especialista;
- `description`: rótulo curto;
- `prompt`: tarefa;
- `model`: opcional, `providerID/modelID#variant`, com instrução explícita para não
  adivinhar;
- `sessionID`: continuar uma conversa anterior do subagente;
- `background`: rodar em background e retornar imediatamente.

Comportamentos importantes:

- **Limite de profundidade** vem de `experimental.subagent_depth`, default 1
  (`:119-133`). O Openclod default é 3 (`src/core/agents/limits.ts:4`).
- **Permissão no tipo de subagente**: `permission.assert({ action: "subagent", resources: [agent.id] })`
  (`:138-151`). Isso permite negar um agente específico sem negar todos.
- **Sessão filha existente** só pode ser continuada se `parentID` for a sessão atual
  (`:164-167`), evitando sequestrar sessão de outro agente.
- **Precedência de modelo**: override explícito > modelo do agente > modelo do pai
  (`:168-184`).
- **Foreground** bloqueia no job; se o usuário cancelar, interrompe e cancela a criança
  (`:234-240`). **Background** retorna `sessionID` e um texto que proíbe polling
  (`:19-27`, `:229-243`).
- Ao terminar, o resultado é injetado na sessão pai como mensagem sintética
  `<subagent sessionID=... state=...>` (`session/subagent-completion.ts:21-45`), com
  `notificationID` para não duplicar.
- A descrição da ferramenta é **atualizada dinamicamente** com a lista de subagentes que o
  agente atual pode chamar, inclusive nos hooks de compaction/generate
  (`tool/plugin/subagent.ts:282-309`).

O Openclod já tem paralelismo, caps de árvore, orçamento por nível, `canCall`, criação
dinâmica de agentes e listagem dinâmica (`src/core/agents/runtime.ts:256-339`,
`src/core/agents/limits.ts:3-46`, `src/core/tools/plan.ts:176-216`). Os gaps são:
**continuar por `sessionID`**, **background com notificação** e **permissão por tipo de
subagente**.

### 4.3 Plan mode e perguntas

`plugin/plan.ts:14-72` implementa Plan mode com dois detalhes bons:

- as regras negam `edit` em tudo, exceto no diretório de planos;
- um `<system-reminder>` é **reinjetado** quando o agente entra/sai do modo e também
  quando uma compactação ou revert o remove (`:55-72`). O lembrete é inserido junto ao fim
  do contexto (antes da última mensagem do usuário, quando ela é a última), para não
  quebrar o prefixo cacheado.

O Openclod tem modos fixos no system prompt (`src/core/agent/context.ts:27-66`), mas uma
compactação pode apagar a lembrança do modo. **Portar o lembrete sintético** é barato e
resolve isso.

A ferramenta `question` (`tool/plugin/question.ts:12-46`) faz perguntas estruturadas com
opções, múltipla escolha, opção “digite sua resposta” e uma permissão própria
(`action: "question"`). O Openclod não tem ferramenta equivalente; o modelo só pode
perguntar em texto e encerrar o turno. **P1 de UX:** um `ask_user` com opções evita
respostas ambíguas e mantém o turno vivo.

### 4.4 Proposta de adaptação (agentes)

1. **Estender `AgentDefinition`** (`src/shared/types.ts:500-526`) com:
   `permissions?: Ruleset`, `request?: { headers?, body? }`, `variant?`, `disabled?`,
   `steps?` (ou manter `maxTurns`), `description` já existe, `hidden` já existe.
2. **Permissão por subagente** no runtime: antes de `spawnAgent`, avaliar
   `subagent:<agentName>` contra o ruleset do chamador; devolver erro textual claro.
3. **Continuar subagente** por `sessionID`: hoje `spawnAgent` sempre cria `childId` novo
   (`src/core/agents/runtime.ts:310-340`). Guardar o transcript da criança e permitir
   `resume` com o mesmo `childId`, validando que o pai é o mesmo.
4. **Background**: executar `spawnAgent` em promessa destacada, retornar `sessionId` e
   injetar `<subagent ...>` no pai ao terminar. O `AgentTree` já tem contadores; falta o
   registro de jobs e a notificação.
5. **Hot reload** de agentes: hoje o registry é recriado por sessão
   (`src/core/agents/registry.ts:65-69`). Adicionar watcher em `%APPDATA%\Openclod\agents`
   e `.forja/agents` com debounce, como o OpenCode faz.
6. **Plan mode**: manter a regra de deny no motor de regras e reinjetar o lembrete após
   compactação, em vez de confiar só no system prompt.

### 4.5 Montagem do prompt de sistema

O OpenCode monta o system prompt em camadas:

1. **Base**: `runner/prompt/system.txt` (harness, comunicação, regras de codebase), com
   `OPENCODE_TOOL_GUIDANCE` substituído por instruções condicionais: só fala de `shell` se
   `shell` está no catálogo; só fala de `write`/`edit` se existem (`session/system-prompt.ts:5-27`;
   `runner/prompt/system.txt:1-15`).
2. **Override do agente**: se o agente tem `system`, ele substitui a base inteira
   (`session/model-request.ts:102-109`).
3. **Instruções iniciais**: `history.initial`, que carrega a data, ambiente e os blocos de
   instrução (Code Mode, MCP, skills, AGENTS.md etc.) na ordem estável→volátil
   (`session/context.ts:126-166`).
4. **Lembretes de modo**: Plan mode injeta `<system-reminder>` como mensagem sintética,
   não como parte do system prompt (`plugin/plan.ts:55-72`).

O Openclod hoje tem um prompt único e monolítico (`src/core/agent/context.ts:165-234`), com
todas as seções e listas dentro dele. Vale portar pelo menos:

- **tool guidance condicional** (não descrever ferramentas que o modo não oferece);
- **ordem estável→volátil** (regras, ambiente, projeto, memória, skills);
- **lembretes de modo como mensagens sintéticas**, não como reescrita do prompt.

---

## 5. Skills

### 5.1 Formato e descoberta

Uma skill é um diretório com `SKILL.md` (ou `<nome>.md`) e frontmatter:

```yaml
---
name: pdf-entrega
description: ...
metadata:
  opencode/autoinvoke: true
disable-model-invocation: false
---
```

Citações: `config/plugin/skill-file.ts:10-15` (campos), `:38-61` (id, nome, autoinvoke),
`config/plugin/skill-scan.ts:7-45` (profundidade máxima 6, ignora dotfiles, segue symlink
com stat), `config/plugin/skill.ts:86-104` (fontes: `skill/` e `skills/` de cada raiz de
config, diretório absoluto/`~/`, URL HTTP).

Skills são recarregadas por watcher com debounce de 100ms (`skill.ts:37-48`, `:169-177`).
O conteúdo é lido do arquivo e a lista é transformada no registry (`:178-190`).

### 5.2 Skills por URL (auto-instalação)

`skill/discovery.ts:92-200` implementa um “registry” simples:

- busca `<url>/index.json` com `{ skills: [{ name, version, files: [...] }] }`;
- valida nome, arquivos, origem e caminho relativo (path traversal, URL absoluta, `..`);
- baixa para `<cache>/skills/<hash-da-url>/<skill>`;
- se a versão mudou, baixa em `staging`, valida `SKILL.md`, grava `.opencode-version` e faz
  swap atômico com backup (`:157-191`);
- concorrência 4 skills / 8 arquivos (`:13-14`).

Isso é diretamente portável para o Openclod e resolve “instalar skill sem reiniciar”.

### 5.3 Injeção no prompt e no contexto

A lista de skills disponíveis é um **Instruction source** com chave
`core/skill-guidance` (`skill/instructions.ts:66-97`):

- só entram skills com `description` e `autoinvoke !== false`;
- a lista é filtrada por permissão `skill:<id>` (`skill.ts:33-34`);
- o render inicial é `<available_skills><skill><id>...` e, quando muda, o OpenCode emite
  **apenas o delta** (adicionadas/alteradas/removidas), não a lista inteira
  (`instructions.ts:35-64`), preservando o prefixo do cache.

A ferramenta `skill` carrega o conteúdo e devolve:

```
<skill_content name="...">
# Skill: ...
...
Base directory for this skill: ...
<skill_files>...</skill_files>  // até 10 arquivos, amostrados
</skill_content>
```

(`skill.ts:36-74`). O modelo é instruído a tratar caminhos relativos como relativos ao
`Base directory` e a ler os arquivos com as ferramentas normais.

### 5.4 Proposta de adaptação (skills)

O Openclod tem `SkillLibrary` local (`src/core/skills/library.ts:26-66`), com cap de 60k
(`:76-81`), `use_skill` que devolve `<skill ... dir="...">` (`src/core/tools/plan.ts:46-73`)
e a lista no system prompt (`src/core/agent/context.ts:167-169`).

Portar, em ordem:

1. **Permissão por skill** (`skill:<id>`) no motor de regras; filtrar a lista e o
   `use_skill`. P1.
2. **`disable-model-invocation` / `autoinvoke`** no frontmatter; skills “manuais” não
   entram na lista, mas podem ser chamadas por nome. P1.
3. **Lista de arquivos + base dir** no retorno de `use_skill` (hoje só tem `dir`). P1
   barato.
4. **Fonte URL com `index.json`, versão e swap atômico**. P2, mas alto valor para
   distribuir skills internas (ex.: `pdf-entrega-affinitas`, `qa-total`).
5. **Delta de instruções**: mover a lista de skills para um bloco estável e emitir deltas
   quando mudar, em vez de reconstruir o system prompt inteiro. P1/P2 (ver 6.4).

---

## 6. Plugins e hooks

### 6.1 Formato e carregamento

Plugins vêm de:

- pacote npm: string `"pkg"` ou `{ package, options }` em `plugins`;
- diretório local: `./plugin`, `opencode.json` com caminho absoluto ou `file://`;
- descoberta automática em diretórios `plugin/`/`plugins/` das raízes de config
  (`config/plugin/source.ts:113-159`).

O carregamento faz `npm.add(target)` quando não é local (`plugin/module.ts:98-124`), ou
seja, **instala dependências automaticamente** no primeiro load. Plugins locais são lidos
por `sources.read` e observados por watcher (`module.ts:26-42`). O entrypoint é resolvido
por `Host.resolve` (`packages/plugin/src/host.ts:17-44`) e importado dinamicamente
(`host.ts:46-48`).

O plugin precisa exportar default com `{ id, effect }` ou `{ id, setup }`
(`module.ts:78-91`, `:125-134`). O `id` é único; duplicata derruba só aquele plugin e é
reportada (`plugin/supervisor.ts:104-117`).

### 6.2 Atualização e política

`plugin/update.ts:11-68` verifica atualização a cada 24h por target, com lock por target e
stream de mudanças; `npm.update` é serializado. `ManagedPolicy` pode bloquear
`plugin:<target>` antes mesmo do load (`module.ts:51-59`).

### 6.3 API de extensão

Plugins recebem um `Context` com domínios transformáveis e hooks
(`packages/core/src/plugin/hooks.ts:13-19`):

| Domínio | O que o plugin pode fazer |
|---|---|
| `agent` | adicionar/alterar/remover agentes |
| `tool` | adicionar/alterar/remover ferramentas; hook `execute.before/after` |
| `skill` | adicionar/alterar/remover skills |
| `mcp` | adicionar/alterar/remover servidores MCP |
| `provider` | adicionar/alterar/remover provedores e modelos |
| `command` | adicionar comandos |
| `permission` | hook `evaluate` (pode negar/alterar mensagem) |
| `session` | hooks `prompt`, `context`, `compaction`, `generate`, `title`, `retry`, HTTP/WS |
| `shell` | hook `create.before` (pode mudar comando/cwd) |
| `aisdk` | hooks do AI SDK |

Hooks são executados em ordem de registro e recebem o evento mutável
(`hooks.ts:88-95`). `tool.execute.before` é o único que pode falhar com `Tool.Error`
(`hooks.ts:23-30`), o que permite bloquear uma chamada antes de executar.

### 6.4 Instruções incrementais (o detalhe mais fino)

`Instructions` (`packages/core/src/instructions/index.ts:33-53`, `:142-192`) é um sistema
de fontes tipadas com:

- `key` estável, codec JSON, `read`, `initial`, `changed`, `removed`;
- hash canônico do valor; um delta guarda apenas hashes que mudaram;
- render inicial e render de atualização separados;
- `combine` valida chaves duplicadas.

Na prática, quando a lista de skills, as instruções de MCP ou o catálogo de Code Mode
mudam, o OpenCode **anexa um delta** ao contexto, em vez de reescrever o bloco inteiro. O
prefixo antigo continua cacheado. O mesmo mecanismo é usado para MCP e Code Mode
(`mcp/instructions.ts:31-59`, `codemode/instructions.ts:32-124`); a lista de skills segue o
mesmo princípio (`skill/instructions.ts:35-64`).

O Openclod reconstrói o system prompt inteiro a cada passo (`src/core/agent/context.ts:165-234`)
e inclui memória e skills voláteis nele. Isso quebra o cache do provedor quando a memória
muda. **Adaptação pragmática:** ordenar o prompt do mais estável para o mais volátil
(regras → ambiente → instruções do projeto → memória → skills) e, quando um bloco volátil
mudar, anexar um `<update>` no fim do contexto em vez de reescrever o bloco. Não é
necessário copiar o sistema de hashes para ganhar a maior parte do benefício.

### 6.5 Proposta de adaptação (plugins)

O Openclod não tem sistema de plugins; tem hooks no formato Claude Code
(`src/core/hooks/runner.ts`) que executam comandos/HTTP externos. Copiar o modelo do
OpenCode (npm + `import()` no mesmo processo) seria um risco de segurança grande.

Recomendação:

- **P2:** criar uma API de extensão **in-process, mas restrita**: um manifesto
  `{ id, version, permissions: ["tool:register", "hook:tool.before", ...], tools, hooks }`,
  sem acesso a `fs`, `child_process` ou `electron`; carregar em `vm`/worker com timeout.
- Não permitir instalação automática de npm pelo agente. Instalação de plugin deve ser
  ação explícita do usuário, com revisão de pacote e lockfile.
- Enquanto isso, ampliar os hooks atuais com decisões estruturadas (o `HookOutcome` já
  tem `permissionDecision` e `additionalContext`) e matchers por ferramenta.

---

## 7. MCP

### 7.1 Configuração e transportes

`packages/schema/src/mcp.ts:7-67` define:

- **local**: `command: string[]`, `cwd`, `environment`, `disabled`, `codemode`;
- **remote**: `url`, `headers`, `oauth` (ou `false`), `disabled`, `codemode`;
- **timeouts** separados: `startup`, `catalog`, `execution`;
- **protocol**: `legacy`, `auto`, `2026-07-28`.

O OpenCode suporta também MCP **attached**: um transporte já aberto por um cliente
(WebSocket) é passado ao core, e os tools desse cliente aparecem como qualquer servidor
(`mcp/client.ts:141-145`, `mcp/index.ts:595-655`). Isso permite conectores hospedados no
app desktop sem expor porta.

### 7.2 Conexão, retry e reconexão

- Conexão inicial: 2 tentativas extras (250ms e 1s) enquanto o erro for transiente e o
  deadline de startup não tiver passado (`client.ts:181-193`, `:294-307`).
- Sessão HTTP expirada: 404, ou 400 com “Server not initialized”, vira
  `SessionExpiredError`; o lifecycle reconecta e **reexecuta a chamada uma vez**
  (`client.ts:238-258`; `mcp/index.ts:362-389`).
- `tools/list_changed`, `prompts/list_changed`, `resources/list_changed` são assinados e
  atualizam o catálogo (tools com debounce de 100ms; prompts/resources na hora)
  (`client.ts:167-172`, `:407-415`; `tool/mcp.ts:127-139`).
- Status: `pending`, `connected`, `failed`, `needs_auth`, `disabled`
  (`schema/mcp.ts:69-88`). A conexão inicial é assíncrona; um servidor lento não bloqueia
  o startup (`mcp/index.ts:660-704`).
- Troca de credencial (login OAuth) reconecta o servidor sem reiniciar o app
  (`mcp/index.ts:706-727`).
- Finalização: tenta `terminateSession` com timeout de 1s, fecha o cliente e mata o
  processo com SIGTERM→SIGKILL (`client.ts:309-331`; `stdio.ts:9-61`).

### 7.3 OAuth

`mcp/oauth.ts:332-543` é uma implementação completa:

- servidor HTTP local em `127.0.0.1`, porta efêmera ou `callback_port`;
- `state` aleatório de 32 bytes, comparação exata;
- PKCE (o SDK cuida do verifier/challenge);
- descoberta de metadata OAuth/OpenID e do `resource_metadata` do 401;
- três formas de registro de cliente: `client_id` estático, **CIMD** (client metadata
  document) ou **DCR** (dynamic client registration);
- reutiliza o cliente registrado anteriormente;
- grava tokens e client info em `Credential` (com refresh token) e invalida quando o
  refresh muda;
- a página de callback só responde sucesso depois que a troca de código terminou
  (`:388-392`, `:501-515`).

É exatamente o que falta no Openclod para conectores remotos (Atlassian, GitHub, Slack,
Linear...).

### 7.4 Exposição das ferramentas

Cada tool MCP vira uma ferramenta do registry com nome
`<server>_<tool>` sanitizado (`tool/mcp.ts:22-23`). A permissão é
`action: "<server>_<tool>", resources: ["*"]` (`:58-70`), então o motor de regras pode
negar tool por tool e agente por agente. O `codemode` é habilitado por padrão; se o
servidor declara `codemode: false`, as tools aparecem diretamente.

As **instruções do servidor** (`initialize.result.instructions`) são injetadas no prompt
como `<mcp_instructions><server name="...">...`, mas só se o servidor tem ao menos uma
tool visível e se a sessão pode executá-la (`mcp/instructions.ts:75-111`). Isso é um ganho
de qualidade enorme e o Openclod hoje ignora `instructions`.

### 7.5 Auto-instalação de MCP

O OpenCode **não tem** ferramenta de agente para instalar MCP. O CLI tem `mcp add`
(`packages/cli/src/commands/handlers/mcp/add.ts:10-37`), que escreve
`mcp.servers.<name>` no `opencode.json`, e `mcp auth`
(`packages/cli/src/commands/handlers/mcp/auth.ts:21-75`), que faz o login OAuth via
cliente e deixa o lifecycle reconectar. A instalação é manual/assistida, não autônoma.

O Openclod está à frente nesse ponto: `mcp_search` consulta catálogo curado + registro
oficial (`src/core/mcp/registry.ts:145-238`) e `mcp_install` salva, conecta e devolve as
tools no mesmo turno (`src/core/tools/mcp.ts:57-144`). O gap é OAuth e robustez.

### 7.6 Proposta de adaptação (MCP)

**P1 — OAuth para MCP remoto**

Implementar no main do Electron:

1. `mcp_auth({ server })` abre um servidor HTTP efêmero em `127.0.0.1` e uma janela
   `BrowserWindow` para a URL de autorização.
2. Descobrir metadata a partir do 401 (`WWW-Authenticate`) e do well-known.
3. Suportar `client_id` estático e DCR; CIMD se o servidor anunciar.
4. Guardar tokens em `safeStorage` (DPAPI) com refresh e expiração; nunca no renderer.
5. Status `needs_auth` no `mcp_servers`; ao concluir, reconectar só aquele servidor.

**P1 — Status individual e reconexão**

Substituir `startMcpServers` all-or-nothing (`src/main/orchestrator.ts:187-211`) por:

```ts
type McpState =
  | { status: 'pending' }
  | { status: 'connected'; tools: number }
  | { status: 'failed'; error: string }
  | { status: 'needs_auth'; error: string }
  | { status: 'disabled' }
```

- conectar cada servidor em paralelo, com `startupTimeout` próprio;
- detectar sessão expirada (404/400 “not initialized”) e reconectar uma vez;
- assinar `notifications/tools/list_changed` e atualizar o registry sem restart;
- ao instalar, salvar config + conectar; se falhar, manter o servidor como `failed`
  (não remover) e mostrar o erro no `mcp_servers`.

**P1 — Timeouts separados** (`startup`, `catalog`, `execution`) e `Retry-After` para
chamadas.

**P2 — Instruções, resources e prompts**: ler `initialize.instructions`, `resources/list`,
`resources/read`, `prompts/list`, `prompts/get` e expor ferramentas para eles
(`mcp_resource`, `mcp_prompt`). O OpenCode já faz isso (`mcp/client.ts:119-138`,
`mcp/index.ts:849-902`).

**P2 — MCP attached**: para conectores que vivem no processo renderer/extensão, aceitar um
transporte WebSocket e registrá-lo como servidor, como `mcp/index.ts:595-655`.

---

## 8. Permissões, aprovações e sandbox

### 8.1 O motor de regras

```ts
// packages/schema/src/permission.ts:56-66
type Effect = "allow" | "deny" | "ask"
type Rule = { action: string; resource: string; effect: Effect }
```

A avaliação é **último match vence** (`findLast`) e o default é `ask`
(`permission.ts:74-84`). O wildcard normaliza `\` para `/`, `*` vira `.*` e `?` vira `.`
(`util/wildcard.ts:3-14`). Recursos podem ser:

- caminho relativo/absoluto (`read`, `edit`, `external_directory`);
- comando de shell (cada comando de um pipeline é um recurso);
- URL (`webfetch`);
- id de skill (`skill`);
- nome de agente (`subagent`);
- `<server>_<tool>` (`mcp`);
- `*` para “qualquer”.

O ruleset efetivo é `agent.permissions + session.permissions` (`permission.ts:145-150`).
Se o agente **não é resolvido** (id inválido ou removido), o default é **deny all**
(`permission.ts:19`). O ruleset do agente default é allow-all com `ask` para `.env`
(`schema/agent.ts:39-52`).

### 8.2 Aprovação: once/always/reject e feedback

`Reply = "once" | "always" | "reject"` (`schema/permission.ts:42`).

- `always` grava uma regra `action + resource` no projeto (`permission/saved.ts:69-84`),
  com unicidade por projeto;
- ao aprovar `always`, o OpenCode **reavalia todos os pedidos pendentes da mesma sessão** e
  aprova os que agora dão `allow` (`permission.ts:290-313`). Isso evita 10 modais depois
  de um “sempre”;
- `reject` **sem mensagem** vira `DeclinedError` e o passo é interrompido; `reject` **com
  mensagem** vira `CorrectedError`, que a ferramenta converte em `ToolFailure` e o modelo
  continua com o feedback (`permission.ts:256-288`, `:222-254`).

O “decline” é tunelado como defeito (die) para que wrappers de ferramenta não o
transformem em output normal; ele ressurge como falha tipada em
`SessionModelRequest.executeTool` (`permission.ts:240-249`; `session/model-request.ts:377-395`).
Isso é deliberado: um “não” não pode ser reinterpretado pelo modelo.

### 8.3 Permissão por ferramenta, não por modo

Cada ferramenta decide sua ação e seus recursos:

| Ferramenta | Ação | Recursos |
|---|---|---|
| `shell` | `"shell"` | cada comando parseado; `save` é o prefixo (`npm run *`) |
| `read` | `"read"` | caminho relativo; antes, `external_directory` se fora do workspace |
| `write`/`edit` | `"edit"` | caminho |
| `webfetch` | `"webfetch"` | URL |
| `skill` | `"skill"` | id |
| `subagent` | `"subagent"` | id do agente |
| MCP | `<server>_<tool>` | `*` |

Exemplos: `tool/plugin/shell.ts:117-155`, `file-access.ts:93-160`,
`tool/plugin/skill.ts:46-67`, `tool/plugin/subagent.ts:138-151`, `tool/mcp.ts:58-70`.

Ferramentas **totalmente negadas** são removidas do snapshot enviado ao modelo, não apenas
bloqueadas na execução (`tool.ts:227-236`, `:293-296`). Isso economiza tokens e evita o
modelo tentar uma ferramenta que não pode usar.

### 8.4 Shell por comando

Esse é o ponto mais interessante para o Openclod. O OpenCode não pede aprovação para “o
comando inteiro”; ele parseia a linha com tree-sitter (bash/PowerShell) e produz uma lista
de comandos e diretórios (`shell/parse.ts:164-207` legado, `:209-288` portátil).

- `cd`/`pushd`/`set-location` não viram comando: viram **diretórios** que passam por
  `external_directory` (`parse.ts:14`, `:192-195`, `:237-265`).
- Cada comando vira `{ resource: <texto do comando>, save: <prefixo> * }`
  (`:196-200`, `:282-285`).
- O prefixo de “sempre” usa uma tabela de arity: `git` → 2 tokens, `npm run` → 3,
  `docker compose` → 3, etc. (`:23-161`). Assim `npm run test` salva `npm run test *`
  (e `npm publish` não é coberto).
- A ferramenta então chama `permission.assert` com **todos** os comandos e diretórios
  (`tool/plugin/shell.ts:123-155`).

O Openclod hoje avalia `run_command` com o texto inteiro em `evaluateRules`
(`src/core/security/rules.ts:103-114`, `:166-179`) e tem uma blocklist por regex
(`src/core/security/policy.ts:93-132`). Portar o parser é esforço L, mas o ganho de
segurança e de UX (“sempre permitir `npm test`” sem liberar `npm publish`) é grande.

### 8.5 Sandbox

**Não há sandbox de SO no OpenCode local.** O `Environment` é uma costura que pode apontar
para um workspace remoto/sandbox, mas o driver local executa no host com `node:fs` e
`ChildProcessSpawner` (`environment/environment.ts:18-35`, `environment/local.ts:17-73`).
A contenção é feita por permissões, aprovação e pelo diretório do projeto. O `file-access`
resolve caminhos lexicalmente e exige `external_directory` para fora do workspace
(`file-access.ts:93-123`), mas isso não impede um comando shell de acessar qualquer coisa
se a permissão `shell` for allow.

O Openclod tem uma postura parecida, mas com `WorkspaceGuard` que resolve symlinks
(`src/core/security/policy.ts:46-89`) e blocklist de comandos destrutivos. Se quisermos
sandbox real, o OpenCode não é referência; seria AppContainer/Job Object no Windows ou um
container.

### 8.6 Proposta de adaptação (permissões)

**P0 — Modelo de regras por recurso**

Substituir/augmentar `PermissionRules { allow/ask/deny: string[] }`
(`src/shared/types.ts:242-246`) por:

```ts
type Rule = { action: string; resource: string; effect: 'allow' | 'ask' | 'deny' }
type Ruleset = Rule[]
```

- `evaluate(action, resource, ...rulesets)` com último match vencendo; default `ask`.
- Migrar as strings Claude Code existentes para regras equivalentes no load (manter o
  parser `Tool(pattern)` como compatibilidade).
- Ações: `run_command`, `read`, `write`, `edit`, `external_directory`, `webfetch`,
  `browser`, `computer`, `skill`, `subagent`, `mcp:<server>_<tool>`.
- `evaluateTool` passa a receber a lista de recursos (ex.: todos os comandos de um
  pipeline), não só o `preview`.

**P0 — Aprovação com feedback e em lote**

Estender `ApprovalResponse` (`src/shared/types.ts:209-215`):

```ts
type ApprovalDecision =
  | { type: 'once' }
  | { type: 'always' }                  // salva ação+recurso no projeto
  | { type: 'deny' }                    // encerra o passo
  | { type: 'deny'; feedback: string }  // devolve ToolFailure e o modelo continua
```

No `resolveApproval` (`src/main/orchestrator.ts:678-709`), ao receber `always`, reavaliar
os pedidos pendentes da mesma sessão e aprovar os que agora são `allow`. Hoje o Openclod
guarda `sessionAllow` por `tool::preview` (`:654-656`) e grava uma regra por
`tool(preview)` (`:683-700`); isso não cobre múltiplos recursos nem wildcards.

**P1 — Shell por comando**

Portar a ideia do parser: no mínimo, dividir por `&&`, `||`, `;`, `|` e `$(...)` e avaliar
cada comando; para produção no Windows, usar o `tree-sitter-powershell`/`tree-sitter-bash`
que o OpenCode usa (`shell/parse.ts:389-403`) ou um parser conservador. Se o parser não
conseguir analisar, cair para “ask no comando inteiro”, nunca para allow.

**P1 — Remover ferramentas negadas do schema**

No `availableTools()` (`src/core/agent/runner.ts:364-380`), cruzar com o ruleset efetivo e
excluir ferramentas com `deny` total. Isso reduz o catálogo e evita loops de “ferramenta
desconhecida”.

**P1 — Concessão efêmera para Computer Use**

Separar “permitido nas configurações” de “concedido nesta sessão”. A sessão recebe
`computer:* allow` só enquanto o usuário mantém o controle ligado e o overlay visível;
ao desligar/fechar, remover a regra.

---

## 9. Auto-instalação: o que existe de fato

| Mecanismo | OpenCode | Evidência | Openclod hoje |
|---|---|---|---|
| Skill por URL | Sim, `index.json` + versão + swap atômico | `skill/discovery.ts:92-200` | Não; só pastas locais (`src/core/skills/library.ts:26-66`) |
| Skill embutida | Sim, plugin registra skills builtin | `plugin/skill.ts:23-48` | Não |
| Plugin npm | Sim, `npm.add` no load | `plugin/module.ts:98-124`; `packages/util/src/npm.ts:207-277` | Não há plugins |
| Atualização de plugin | Check a cada 24h | `plugin/update.ts:11-68` | Não |
| MCP pelo agente | **Não**; só CLI `mcp add`/`mcp auth` | `packages/cli/src/commands/handlers/mcp/add.ts:10-37` | **Sim**, catálogo + registro (`src/core/mcp/registry.ts:145-238`, `src/core/tools/mcp.ts:57-144`) |
| MCP OAuth | Sim, fluxo completo | `mcp/oauth.ts:332-543` | **Não**; retorna “peça um token” (`src/core/tools/mcp.ts:111-116`) |
| Integração well-known | Sim, `/.well-known/opencode` | `wellknown.ts:65-102`, `:119-163` | Não |
| Agente que cria agente | Não no v2 | — | **Sim**, `create_agent` (`src/core/agents/tools.ts:10-73`) |

Conclusão honesta: o OpenCode é mais maduro em **skills por URL, OAuth e plugins**; o
Openclod é mais maduro em **auto-instalação de MCP pelo agente e criação de agentes**. As
duas direções são complementares, não concorrentes.

---

## 10. O que não encontrei (e não deve ser inventado)

1. **Computer Use de SO no OpenCode.** Não há mouse/teclado globais, captura de tela do
   desktop, UIA/Win32 ou ferramentas de janela. O “browser” é Chromium via CDP.
2. **Fallback de modelo.** Não há cadeia A→B em falha de provedor. Há retry do mesmo
   modelo, fallback de transporte WebSocket→HTTP, modelo “small” para título
   (`packages/core/src/session/context.ts:94-124`) e um agente de compactação com modelo
   próprio (`compaction.ts:264-282`).
3. **Sandbox de SO.** O driver local é `node:fs` + spawn direto; a política é o controle.
4. **Plugin sandbox.** Plugins são importados no processo, com o `Context` completo do
   host; não há isolamento de permissões por plugin além da política gerenciada.
5. **Auto-instalação de MCP pelo modelo.** Só CLI manual.
6. **Marketplace de skills.** O “registry” é um `index.json` servido por URL, sem
   assinatura, curadoria ou resolução de dependências.
7. **Loop de verificação visual com modelo.** O browser tira screenshot, mas não há um
   “verificador” separado olhando a imagem e decidindo se a ação funcionou; a verificação é
   instrução de prompt + erros estruturados.
8. **Compactação nativa universal.** Há suporte a `native` compaction quando o provedor
   oferece (`compaction.ts:518-557`), mas não é o caminho padrão.
9. **Telemetria/avaliação de qualidade do harness.** Não encontrei uma suíte de avaliação
   de comportamento do agente; há testes de provedor, cenários gravados de protocolo
   (`packages/ai/test/recorded-scenarios.ts`) e benchmarks de UI, não um benchmark de
   tarefas do harness.

---

## 11. Roadmap priorizado para o Openclod

Critérios: **impacto** = confiabilidade/segurança/UX para o produto; **esforço** = dias de
um engenheiro familiarizado com o código, incluindo testes.

### P0 — fazer primeiro

| # | Item | Impacto | Esforço | Onde mexer | Critério de pronto |
|---|---|---|---|---|---|
| P0.1 | Aprovação com `deny + feedback`, `always` em lote e regras salvas por ação+recurso | Alto | M (3-4d) | `src/shared/types.ts:209-246`, `src/core/security/{permissions,rules}.ts`, `src/main/orchestrator.ts:654-709`, UI de aprovação | “Sempre” aprova pedidos pendentes equivalentes; “não, faça X” chega ao modelo como erro de ferramenta e o turno continua |
| P0.2 | Motor de regras `action/resource/effect` com wildcard e último-match | Alto | M (4-5d) | `rules.ts`, `permissions.ts`, settings, migração das strings atuais | Uma regra `run_command: "npm run *"` libera `npm run test` e não `npm publish`; regras antigas continuam funcionando |
| P0.3 | Computer Use: refs + geração + verificação pós-ação + erros estruturados + “outcome unknown” | Alto | L (5-7d) | `src/core/computer/layer.ts:162-272`, `src/core/tools/computer.ts`, `src/shared/types.ts` | Clique com snapshot antigo falha com instrução de novo snapshot; ação mutável devolve `changed` e diff; timeout não convida a repetir |
| P0.4 | Inbox `steer`/`queue` e retomada de turno | Alto | M (3-5d) | `src/core/agent/runner.ts:608-640`, `src/main/orchestrator.ts`, store, preload/renderer | Usuário envia correção durante o turno; agente a vê no próximo passo; nada é perdido ao reiniciar |
| P0.5 | Concessão efêmera de Computer Use por sessão + overlay | Alto | S/M (2-3d) | `src/core/security/permissions.ts`, `src/core/tools/computer.ts:6-11`, `src/main/computer-overlay.ts` | Controle só vale na sessão concedida; overlay visível; fechar a sessão revoga |

### P1 — em seguida

| # | Item | Impacto | Esforço | Onde mexer | Critério de pronto |
|---|---|---|---|---|---|
| P1.1 | MCP OAuth + status individual + reconexão + timeouts separados | Alto | L (6-10d) | `src/core/mcp/client.ts`, `src/main/orchestrator.ts:187-211`, settings, janela de auth | Servidor remoto com OAuth conecta, guarda refresh em `safeStorage`, reconecta sozinho; um servidor lento não bloqueia os outros |
| P1.2 | Compactação: `usage` real, precompute, validação de template, modelo separado, shrink ladder | Alto | M (4-6d) | `src/core/agent/compaction.ts`, `src/core/agent/runner.ts:941-964` | Contexto de 200k compacta sem estourar; resumo inválido é corrigido; latência do resumo sai do caminho crítico |
| P1.3 | Retry: `Retry-After`, jitter, limite de timeout, continuação de stream parcial | Médio/Alto | S (1-2d) | `src/core/agent/runner.ts:769-813`, providers/http | 429 com `Retry-After` é respeitado; stream que caiu após output continua em vez de duplicar |
| P1.4 | Orçamento dinâmico de output e de imagens | Médio/Alto | S (1-2d) | `src/core/providers/*`, `src/core/agent/runner.ts:890-895` | Requests não estouram por `max_tokens` fixo; sessão com muitas screenshots não cresce sem limite |
| P1.5 | Shell por comando + `external_directory` para `cd` | Alto | L (5-8d) | `src/core/security/rules.ts`, `src/core/tools/shell.ts`, novo parser | `cd` fora do projeto pede aprovação; pipeline avalia cada comando; “sempre” salva prefixo seguro |
| P1.6 | Skills: permissão por skill, `autoinvoke`, lista de arquivos/base dir, fonte URL | Médio | M (3-5d) | `src/core/skills/library.ts`, `src/core/tools/plan.ts:46-94`, `src/core/agent/context.ts` | Skill pode ser oculta do modelo e chamada por nome; skill instalada por URL atualiza com versão |
| P1.7 | Agentes: permissões/modelo/request no markdown, hot reload, subagente background/resume | Médio/Alto | M/L (5-8d) | `src/core/agents/{loader,registry,runtime}.ts`, `src/shared/types.ts:500-526` | Agente declara `permissions` e `model`; editar o `.md` recarrega; `agent` aceita `background` e `sessionId` |
| P1.8 | Remover ferramentas negadas do schema e varrer tool calls órfãs no boot | Médio | S (1d) | `src/core/agent/runner.ts:364-380`, `src/main/orchestrator.ts` | Catálogo menor; nenhum spinner eterno após crash |
| P1.9 | `ask_user` estruturado (opções + texto livre) | Médio | S (1-2d) | `src/core/tools/`, `src/shared/types.ts`, renderer | Pergunta com opções mantém o turno vivo e retorna resposta estruturada |

### P2 — depois

| # | Item | Impacto | Esforço | Observação |
|---|---|---|---|---|
| P2.1 | Instruções/resources/prompts de MCP + `list_changed` | Médio | M | Fecha o gap de “conector de verdade”; `mcp/instructions.ts:75-111` é o modelo |
| P2.2 | Code Mode (`execute` com catálogo de tools) | Médio | L | Útil quando o catálogo MCP passar de ~40 tools; o OpenCode usa `tool.ts:236-262` e `codemode/tool.ts:70-151` |
| P2.3 | API de plugins restrita e isolada | Médio | L | Não copiar npm+import in-process; definir manifesto, permissões e worker |
| P2.4 | MCP attached (transporte do cliente) | Baixo/Médio | M | Para conectores hospedados no renderer/extensão |
| P2.5 | Paridade de browser: frames, network, trace, dialog, upload | Médio | M | O Playwright do Openclod já cobre parte; priorizar o que o usuário usa |
| P2.6 | Plan mode com regra deny + lembrete reinjetado | Baixo/Médio | S | `plugin/plan.ts:14-72` é o modelo |
| P2.7 | Job durável de subagente (retomar após restart) | Médio | L | `job.ts` + `subagent-job.ts`; depende do inbox P0.4 |
| P2.8 | Retenção/limpeza de spill de ferramentas | Baixo | S | O OpenCode limpa após 7 dias (`tool-output.ts:13-16`, `:40-50`) |

### Sequência sugerida

1. **Semana 1-2:** P0.1 + P0.2 (a base de segurança/UX; tudo mais depende do motor de
   regras).
2. **Semana 2-3:** P0.3 + P0.5 (Computer Use confiável e com escopo).
3. **Semana 3-4:** P0.4 (inbox) + P1.8 (limpeza de estado).
4. **Mês 2:** P1.1 (MCP OAuth/status), P1.2 (compactação), P1.3/P1.4 (retry/orçamento).
5. **Mês 2-3:** P1.5 (shell), P1.6 (skills), P1.7 (agentes), P1.9 (ask_user).
6. **Depois:** P2 conforme demanda de conectores e catálogo de tools.

---

## 12. Apêndice: índice de citações

### OpenCode

| Tema | Arquivo:linha |
|---|---|
| Loop/drain | `packages/core/src/session/runner/llm.ts:56-194` |
| Passo/retry/compactação | `packages/core/src/session/runner/llm.ts:206-338` |
| Uma tentativa de provedor | `packages/core/src/session/runner/step.ts:52-300` |
| `needsContinuation` | `packages/core/src/session/runner/publish-llm-event.ts:645-654` |
| Limite de output | `packages/core/src/session/runner/llm.ts:34-38`, `:299-328` |
| Max steps | `packages/core/src/session/runner/max-steps.ts:1-16`; `runner/llm.ts:224-243` |
| Retry | `packages/core/src/model-retry.ts:11-59`; `runner/retry.ts:35-54` |
| Compactação | `packages/core/src/session/compaction.ts:118-157`, `:284-349`, `:570-650`, `:954-999`, `:1072-1098` |
| Orçamento de output | `packages/core/src/session/model-request.ts:47-90` |
| Orçamento de imagens | `packages/core/src/session/model-request.ts:42-45`, `:181-209` |
| Inbox | `packages/schema/src/session-inbox.ts:11`, `:37-49`; `packages/core/src/session/inbox.ts:44-49` |
| Tool calls órfãs | `packages/core/src/session/runner/llm.ts:341-394` |
| Permissões | `packages/core/src/permission.ts:19`, `:74-84`, `:145-176`, `:214-316` |
| Regras salvas | `packages/core/src/permission/saved.ts:69-84` |
| Wildcard | `packages/core/src/util/wildcard.ts:3-14` |
| Shell parser | `packages/core/src/shell/parse.ts:14`, `:23-161`, `:164-288` |
| Shell permissão | `packages/core/src/tool/plugin/shell.ts:117-155` |
| File access | `packages/core/src/file-access.ts:93-160` |
| Ferramenta negada some | `packages/core/src/tool.ts:227-236`, `:293-296` |
| Agente (schema) | `packages/schema/src/agent.ts:23-52` |
| Agente markdown | `packages/core/src/config/plugin/agent.ts:21-33`, `:95-128`, `:178-217` |
| Builtins | `packages/core/src/plugin/agent.ts:55-116` |
| Subagente | `packages/core/src/tool/plugin/subagent.ts:19-48`, `:100-151`, `:153-267`, `:282-309` |
| Subagente conclusão | `packages/core/src/session/subagent-completion.ts:21-45` |
| Plan mode | `packages/core/src/plugin/plan.ts:14-72` |
| Question tool | `packages/core/src/tool/plugin/question.ts:12-46` |
| Skills | `packages/core/src/config/plugin/skill-file.ts:10-15`, `:38-61`; `skill-scan.ts:7-45`; `config/plugin/skill.ts:86-177` |
| Skill URL | `packages/core/src/skill/discovery.ts:92-200` |
| Skill prompt | `packages/core/src/skill/instructions.ts:16-97`; `skill.ts:36-74`; `tool/plugin/skill.ts:46-67` |
| Instruções incrementais | `packages/core/src/instructions/index.ts:33-53`, `:142-192` |
| Plugins | `packages/core/src/plugin/module.ts:98-124`; `supervisor.ts:59-117`; `update.ts:11-68` |
| Plugin hooks | `packages/core/src/plugin/hooks.ts:13-30`, `:88-95` |
| MCP config | `packages/schema/src/mcp.ts:7-67`, `:69-88` |
| MCP client | `packages/core/src/mcp/client.ts:181-193`, `:238-307`, `:332-389` |
| MCP lifecycle | `packages/core/src/mcp/index.ts:362-505`, `:595-655`, `:660-727` |
| MCP OAuth | `packages/core/src/mcp/oauth.ts:332-543` |
| MCP tools | `packages/core/src/tool/mcp.ts:22-23`, `:48-70`; `mcp/instructions.ts:75-111` |
| MCP CLI | `packages/cli/src/commands/handlers/mcp/add.ts:10-37` |
| Well-known | `packages/core/src/wellknown.ts:65-102`, `:119-163` |
| Code Mode | `packages/core/src/codemode/tool.ts:70-151`; `codemode/instructions.ts:32-124` |
| Browser tools | `packages/plugin-browser/src/tools.ts:41-53`; `rpc.ts:160-330` |
| Browser conexão | `packages/plugin-browser/src/connection.ts:24-53`, `:166-178`, `:203-251` |
| Browser refs/geração | `packages/gui-extensions/src/browser/chromium.ts:295-327`, `:610-627`, `:1443-1519`; `refs.ts:1-21` |
| Browser erros | `packages/gui-extensions/src/browser/errors.ts:3-49` |
| Tool output | `packages/core/src/tool-output.ts:13-16`, `:40-50`, `:69-120` |
| Ambiente | `packages/core/src/environment/environment.ts:18-35`; `local.ts:17-73` |

### Openclod

| Tema | Arquivo:linha |
|---|---|
| Loop/limites | `src/core/agent/runner.ts:43-64`, `:661-707`, `:769-876`, `:941-981` |
| Fallback | `src/core/agent/runner.ts:66-77`, `:797-813` |
| Aprovação | `src/shared/types.ts:198-246`; `src/main/orchestrator.ts:654-709` |
| Regras | `src/core/security/rules.ts:47-57`, `:103-179`, `:192-198` |
| Avaliação | `src/core/security/permissions.ts:7-27`, `:43-91`, `:93-203` |
| Workspace | `src/core/security/policy.ts:23-89`, `:93-132` |
| Compactação | `src/core/agent/compaction.ts:21-25`, `:52-96`, `:137-186` |
| Computer layer | `src/core/computer/layer.ts:84-97`, `:162-206`, `:216-272` |
| Computer tools | `src/core/tools/computer.ts:6-11`, `:38-39`, `:481-539` |
| MCP client | `src/core/mcp/client.ts:151-155`, `:182-245`, `:252-296`, `:341-419` |
| MCP registry/install | `src/core/mcp/registry.ts:145-238`; `src/core/tools/mcp.ts:57-144` |
| Skills | `src/core/skills/library.ts:26-66`, `:76-81`; `src/core/tools/plan.ts:46-94` |
| Agentes | `src/core/agents/runtime.ts:256-339`; `limits.ts:3-46`; `registry.ts:46-69` |
| Agent tool | `src/core/tools/plan.ts:145-243` |
| System prompt | `src/core/agent/context.ts:165-234` |

---

## 13. Lista priorizada (resumo)

| Prioridade | Item | Impacto | Esforço |
|---|---|---|---|
| **P0** | Aprovação com `deny + feedback`, `always` em lote, regras salvas por ação+recurso | Alto | M (3-4d) |
| **P0** | Motor de regras `action/resource/effect` com wildcard e último-match | Alto | M (4-5d) |
| **P0** | Computer Use com refs/geração, verificação pós-ação, erros estruturados e “outcome unknown” | Alto | L (5-7d) |
| **P0** | Inbox `steer`/`queue` e retomada de turno | Alto | M (3-5d) |
| **P0** | Concessão efêmera de Computer Use por sessão + overlay | Alto | S/M (2-3d) |
| **P1** | MCP OAuth + status individual + reconexão + timeouts separados | Alto | L (6-10d) |
| **P1** | Compactação com `usage` real, precompute, validação e modelo separado | Alto | M (4-6d) |
| **P1** | Retry com `Retry-After`/jitter/limite de timeout + continuação de stream parcial | Médio/Alto | S (1-2d) |
| **P1** | Orçamento dinâmico de output e de imagens | Médio/Alto | S (1-2d) |
| **P1** | Shell por comando + `external_directory` para `cd` | Alto | L (5-8d) |
| **P1** | Skills com permissão, `autoinvoke`, base dir/arquivos e fonte URL | Médio | M (3-5d) |
| **P1** | Agentes com permissões/modelo/request no markdown, hot reload, subagente background/resume | Médio/Alto | M/L (5-8d) |
| **P1** | Remover ferramentas negadas do schema + varrer tool calls órfãs no boot | Médio | S (1d) |
| **P1** | `ask_user` estruturado | Médio | S (1-2d) |
| **P2** | MCP instructions/resources/prompts + `list_changed` | Médio | M |
| **P2** | Code Mode (`execute` com catálogo de tools) | Médio | L |
| **P2** | API de plugins restrita e isolada | Médio | L |
| **P2** | MCP attached (transporte do cliente) | Baixo/Médio | M |
| **P2** | Paridade de browser: frames, network, trace, dialog, upload | Médio | M |
| **P2** | Plan mode com regra deny + lembrete reinjetado | Baixo/Médio | S |
| **P2** | Job durável de subagente (retomar após restart) | Médio | L |
| **P2** | Retenção/limpeza de spill de ferramentas | Baixo | S |

A ordem de execução recomendada está na seção 11; os critérios de pronto estão nas
tabelas detalhadas de P0 e P1.

---

## 14. Nota final

O maior ganho não está em copiar uma feature isolada, e sim em **separar responsabilidades
que hoje estão no mesmo laço**: decisão de continuar, tentativa de provedor, aprovação,
verificação de Computer Use e compactação. O OpenCode chama essas coisas de `Step`,
`Attempt`, `Permission`, `Browser.Action` e `Compaction`; o Openclod pode adotar os mesmos
contratos sem adotar Effect, SQLite ou a arquitetura de plugins.

As três apostas com melhor relação impacto/esforço são, na ordem:

1. **Aprovação com feedback + regras por recurso** — melhora segurança e UX de uma vez.
2. **Computer Use com geração/ref e verificação pós-ação** — transforma “o modelo disse que
   clicou” em “o harness confirma que a tela mudou”.
3. **Inbox `steer`/`queue`** — permite corrigir o agente sem matar o turno, que é o que
   usuários de tarefas longas mais sentem falta.

Nenhum arquivo do Openclod foi alterado além deste relatório; nenhum commit foi feito.
