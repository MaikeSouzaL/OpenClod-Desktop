# OpenHands / Agent Canvas

| Campo | Valor |
|---|---|
| Repositório | https://github.com/All-Hands-AI/OpenHands |
| Clone local | `repositorios/_research/agents/All-Hands-AI--OpenHands` |
| Commit | `b185939d3dec3b203b0651c675f175ee5b4ed43e` |
| Licença | MIT (`LICENSE:1`) |
| Categoria | agents (cliente/controle de agentes) |
| Stack | TypeScript 6.0.3 + React 19.3 + React Router 7 + Vite 8 + Zustand 5 + TanStack Query 5 + Tailwind 4 + Electron 43 + Vitest 5/Playwright; npm |
| Tamanho | 2.800 arquivos (sem `.git`/`node_modules`); 1.462 `.ts/.tsx` e ~177 mil linhas em `src/`, `electron/`, `tests/` |

## 1. O que é (verificado no código)

O clone **não contém o loop do agente**. Ele é o *Agent Canvas*: uma UI React
Router (`package.json:2`, `package.json:7`) que conversa por HTTP/WebSocket com
um `agent-server` Python iniciado à parte via `uvx` (`bin/agent-canvas.mjs:5-8`,
`config/defaults.json:4`). O wrapper Electron sobe esse stack inteiro (agent-server
+ automation + proxy + frontend estático) e só então abre a janela
(`electron/main.mjs:4-5`). Ou seja: o produto deste repositório é o **cliente
rico** do harness — streaming, eventos, permissões, diff, terminal, forks,
delegação e automações —, não o raciocínio do modelo.

O README chama o projeto de "self-hosted developer control center"
(`README.md:7`) e isso confere com as rotas reais: conversas, automações,
skills/plugins, MCP, backends e settings (`src/routes.ts:9-35`). A divergência
relevante: o nome do repo é OpenHands, mas o código Python do agente não está
aqui; a versão do servidor é um pin externo (`config/defaults.json:4-9`), com
checagem de compatibilidade mínima (`src/api/agent-server-compatibility.ts:20-25`).

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `npm run dev` | `package.json:77` | sobe o stack de desenvolvimento com automação |
| `npm run dev:frontend` | `package.json:81` | React Router dev com API real |
| `npm run dev:mock` | `package.json:82` | idem, com `VITE_MOCK_API=true` |
| `npm run build` | `package.json:83` | build do app (i18n + react-router build) |
| `npm test` | `package.json:86` | gera i18n e roda `vitest run` |
| `npm run test:e2e` | `package.json:87` | Playwright (passa sem testes) |
| `npm run test:e2e:mock-llm` | `package.json:89` | E2E com LLM falso |
| `npm run test:mutation` | `package.json:93` | Stryker |
| `npm run typecheck` | `package.json:104` | `react-router typegen && tsc` |
| `agent-canvas` | `bin/agent-canvas.mjs:1` | CLI publicada: sobe stack completo |
| `--frontend-only` / `--backend-only` | `bin/agent-canvas.mjs:54-56` | separa frontend de backend |
| `--public` | `bin/agent-canvas.mjs:54` | expõe o ingress fora do loopback |
| `--version` / `--info` / `--help` | `bin/agent-canvas.mjs:27-58` | versões pinadas, portas e env vars |

Superfície de UX: rotas em `src/routes.ts:9-44` (`/conversations/:id`,
`/conversations/:id/panel`, `/launch`, `/skills`, `/plugins`, `/apps`, `/mcp`,
`/settings/{llm,agent,condenser,verification,secrets}`, `/automations/*`).
Slash commands embutidos: `/new`, `/btw`, `/model`, `/goal`, `/plan`, `/code`
(`src/utils/constants.ts:38-117`), mais comandos derivados de skills
(`src/hooks/chat/use-slash-command.ts:57-80`). IPC do Electron é mínimo e
expõe só a shell e o bridge MARS (`electron/preload-main.cjs:30-55`), sem
canal de ferramentas.

## 3. Arquitetura e fluxo

```
bin/agent-canvas.mjs (uvx agent-server :18000 + automation :18001 + ingress :8000)
   → React Router (src/routes.ts) → ConversationWebSocketProvider
   → frames (event | delta | item_started) → Zustand use-event-store
   → componentes de evento / terminal / diff
   → POST /api/conversations/{id}/events (mensagem) e respond_to_confirmation
```

- Entry point web: `src/entry.client.tsx`; rotas em `src/routes.ts:8-45`.
- Entry point desktop: `electron/main.mjs:4-5` (spawn do stack antes da janela).
- Loop do agente: **não está no clone**; roda no agent-server externo. O que o
  clone implementa é o *loop de eventos* do cliente:
  `src/contexts/conversation-websocket-context.tsx:1142-1200`.
- Execução de ferramenta: também no servidor; o cliente só renderiza a ação e
  devolve resultado para *client tools*
  (`src/services/client-tool-result.ts:16-28`).
- Streaming: dois batchers independentes (principal e planejamento)
  `src/contexts/conversation-websocket-context.tsx:255-267`, commit por frame
  de animação em `src/utils/streaming-delta-batcher.ts:29-57`.
- Persistência: servidor (histórico REST + `after_seq`); no browser só estado de
  UI em `localStorage` (`src/utils/conversation-local-storage.ts:14-44`).

## 4. Catálogo de ferramentas / capacidades

As ferramentas são **contratos de protocolo** reproduzidos em TypeScript; quem
executa é o servidor. O catálogo real de ações está em
`src/types/agent-server/core/base/action.ts`:

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `ExecuteBashAction` | `src/types/agent-server/core/base/action.ts:29-46` | comando de shell, input em processo vivo, timeout, reset de sessão | alto |
| `TerminalAction` | `.../action.ts:48-65` | variante de terminal persistente | alto |
| `FileEditorAction` | `.../action.ts:67-96` | `view/create/str_replace/insert/undo_edit` com `view_range` | médio |
| `StrReplaceEditorAction` | `.../action.ts:98-127` | alias do editor por substituição | médio |
| `MCPToolAction` | `.../action.ts:8-13` | chamada dinâmica a ferramenta MCP | alto ( depende do servidor MCP) |
| `FinishAction` / `ThinkAction` | `.../action.ts:15-27` | encerrar turno / pensamento explícito | baixo |
| `launch_child_conversation` (client tool) | `src/api/launch-child-conversation-client-tool.ts:61-...` | cria conversa filha local (worktree) ou cloud | alto (delega execução) |
| `request_secret` (client tool) | `src/api/request-secret-client-tool.ts:27-53` | pede credencial por formulário, grava como env var | médio |
| `canvas_ui` (client tool) | `src/api/canvas-ui-client-tool.ts` | renderiza UI interativa no chat | baixo |
| `automation_form_update` | `src/api/automation-form-client-tool.ts` | preenche formulário de automação | baixo |
| ACP tool call | `src/components/conversation-events/chat/event-content-helpers/get-acp-tool-call-content.ts` | renderiza chamadas de agentes ACP | variável |
| Browser (navegar/observar) | `src/types/agent-server/type-guards.ts:174-210` | eventos de navegador embutido | médio |

## 5. Loop do agente, contexto e streaming

Como o loop é remoto, o que existe aqui é um **loop de consumo de eventos**
muito disciplinado. Cada socket mantém um cursor de `seq`
(`src/utils/session-seq-cursor.ts`, usado em
`conversation-websocket-context.tsx:276-277`); o reconnect envia
`after_seq` em vez de reenviar tudo (`...:1142-1151`), o que evita duplicar
texto quando a aba volta. Frames duráveis avançam o cursor; frames `delta` não
(`...:163-196`).

Texto é bufferizado e aplicado no máximo uma vez por frame de animação, com a
regra explícita de `flush()` antes de qualquer frame não-delta
(`src/utils/streaming-delta-batcher.ts:29-57`). Há dois batchers para não
misturar o stream principal com o do planner
(`conversation-websocket-context.tsx:255-267`). A ordem dos eventos é
recomposta por timestamp, com ordenação só quando chega evento fora de ordem
(`src/stores/use-event-store.ts:24-57`).

Contexto/compactação: o cliente pede `POST /api/conversations/{id}/condense`
(`src/api/conversation-service/agent-server-conversation-service.api.ts:1028-1040`),
mas o ack HTTP só significa "começou". A UI espera um evento `Condensation` e
uma queda de `per_turn_token` para reportar quantos tokens foram liberados, com
timeout de 90 s e settle de 2,5 s (`src/hooks/use-await-context-compaction.ts:6-9`,
`:71-100`). O botão fica desabilitado com o agente rodando
(`src/hooks/use-compact-context-action.ts:35-39`).

Cancelamento/retry: stop vai por mutação própria
(`src/hooks/mutation/use-unified-stop-conversation.ts`); reconexão tem backoff
1 s → 30 s (`src/hooks/use-websocket.ts:25-27`) e watchdog de handshake para
socket preso em `CONNECTING` (`...:69-72`).

## 6. Sessões, estado e persistência

A conversa é a unidade de sessão no servidor; o cliente guarda apenas o estado
de navegação por conversa num único blob de `localStorage`
(`src/utils/conversation-local-storage.ts:25-45`): aba selecionada, abas
desafixadas, `conversationMode` (`plan`/`code`), taskId de subconversa, rascunho.
O painel direito é deliberadamente **não** persistido (`...:28-35`).

Fork é server-side: `useForkConversation` resolve o evento pai quando o usuário
edita uma mensagem e ramifica a partir dele, detectando servidores antigos que
ignoram `from_event_id` pelo `leaf_event_id` (`src/hooks/mutation/use-fork-conversation.ts:38-68`).
Há ainda exportação de transcript em Markdown/HTML
(`src/utils/transcript-export/index.ts:41-45`) e download da conversa
(`src/api/conversation-service/agent-server-conversation-service.api.ts:972`).

## 7. Configuração e extensibilidade

- Config do stack: `config/defaults.json` (versões, portas, paths, pacotes),
  sobrescrita por env (`OH_AGENT_SERVER_VERSION`, `OH_AGENT_SERVER_GIT_REF`,
  `OH_AGENT_SERVER_LOCAL_PATH`) documentada em `bin/agent-canvas.mjs:49-51`.
- Settings por tipo: LLM, meta-LLM, agente, condensador, contexto, verificação,
  secrets (`src/routes.ts:24-35`).
- Extensões: skills (AgentSkills), plugins, "apps"/canvas extensions e MCP
  (`src/routes.ts:19-23`; `src/api/plugins-service.ts`,
  `src/api/plugins-management-service.ts`, `src/hooks/use-mcp-server-health.ts`).
- Hooks de conversa: `src/api/hooks-service.ts` e `use-conversation-hooks.ts`.
- ACP: qualquer agente compatível (Claude Code, Codex, Gemini, Pi, OpenCode) é
  configurado por `acp_command` em argv, com tokenizer próprio para não destruir
  URLs (`src/utils/acp-command.ts:11-45`).
- Perfis de agente e de LLM são entidades separadas, com migração
  (`src/hooks/mutation/use-activate-agent-profile.ts`,
  `src/hooks/use-migrate-default-agent-profile.ts`).

## 8. Permissões, sandbox e erros

O modo de confirmação é um flag do servidor (`confirmation_mode`) exibido como
cadeado no compositor (`src/components/features/chat/confirmation-mode-enabled.tsx:12-26`).
Quando o agente para em `AWAITING_USER_CONFIRMATION`
(`src/types/agent-state.tsx:12`), a UI mostra aceitar/rejeitar, com alerta de
risco e deduplicação por `submittedEventIds` para não enviar duas respostas
(`src/components/shared/buttons/conversation-confirmation-buttons.tsx:30-59`).
A resposta vai para `respond_to_confirmation` no runtime da conversa
(`src/api/event-service/event-service.api.ts:40-51`;
`src/hooks/mutation/use-respond-to-confirmation.ts:12-31`).

Risco é classificado no evento de ação (`security_risk` em
`src/types/agent-server/core/events/action-event.ts:58-61`, enum
`src/types/agent-server/core/base/common.ts:59-64`). O isolamento real é do
backend: local (acesso total ao FS, avisado no README `README.md:65`), Docker
ou cloud sandbox; o cliente só escolhe o backend e mostra saúde
(`src/api/backend-registry/health-store.ts`). Erros de socket e de servidor têm
stores próprios (`src/stores/error-message-store.ts`) e um
`AGENT_SERVER_UNSUPPORTED_VERSION` dedicado
(`src/api/agent-server-compatibility.ts:22-25`).

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Unit (Vitest) | `package.json:86`; 69 arquivos `*.test.ts(x)` em `src/` | hooks, stores, api, utils |
| Node-env pilot | `vite.config.ts:30-40` | suítes sem DOM rodando em Node |
| E2E Playwright | `package.json:87-91`; 31 specs em `tests/` | fluxos de UI e bind policy |
| Mock LLM | `playwright.mock-llm.config.ts` | E2E determinístico sem modelo |
| Mutação | `package.json:93` + `stryker.config.mjs` | qualidade dos testes |
| Lint/type | `package.json:100-105` | ESLint + Prettier + `tsc` |

Há testes de contrato específicos que valem como ideia: proibição de chamadas
diretas ao agent-server fora da camada de API
(`src/api/no-direct-agent-server-calls.test.ts`) e compatibilidade de versão
(`src/api/agent-server-compatibility.test.ts`).

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Batcher de deltas por frame | `src/utils/streaming-delta-batcher.ts:29-71` | evita re-render por token e força ordem antes de frame durável | MIT | `src/core/streaming/delta-batcher.ts` | 24 |
| Cursor `seq` + resume `after_seq` | `src/utils/session-seq-cursor.ts`; `src/contexts/conversation-websocket-context.tsx:1142-1151` | reconexão sem duplicar nem perder eventos | MIT | `src/core/session/seq-cursor.ts` | 23 |
| Dedupe e fluxo de confirmação | `src/components/shared/buttons/conversation-confirmation-buttons.tsx:30-59` | impede duplo aceite e cobre risco | MIT | `src/renderer/.../confirmation` | 22 |
| Delegação com brief autocontido | `src/api/launch-child-conversation-client-tool.ts:14-59` | prompt de tool que ensina isolamento/worktree e handoff | MIT | `src/core/tools/launch-child.md` | 22 |
| Fork a partir de evento + edit | `src/hooks/mutation/use-fork-conversation.ts:38-68` | checkpoint por mensagem com fallback de versão | MIT | `src/core/session/fork.ts` | 21 |
| Medição de compactação | `src/hooks/use-await-context-compaction.ts:6-100` | mede tokens salvos de verdade, não o ack | MIT | `src/core/context/compaction.ts` | 20 |
| Export de transcript MD/HTML | `src/utils/transcript-export/index.ts:41-...` | prova auditável da sessão | MIT | `src/core/export/transcript.ts` | 18 |
| Client tool por mensagem prefixada | `src/services/client-tool-result.ts:16-28` | protocolo simples para tools do UI | MIT | `src/core/tools/client-result.ts` | 17 |
| Preferência de aba/estado por conversa | `src/utils/conversation-local-storage.ts:25-45` | UX que sobrevive a reload sem sujar o servidor | MIT | `src/renderer/state/conversation-ui.ts` | 15 |
| Gate de versão do servidor | `src/api/agent-server-compatibility.ts:20-25` | evita UI nova contra backend velho | MIT | `src/core/protocol/version-gate.ts` | 14 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Todo o stack React Router + rotas + 692 componentes | já temos UI própria; custo de adaptação alto e Tailwind/HeroUI incompatível |
| `@openhands/typescript-client` como dependência | acopla ao protocolo fechado do agent-server deles |
| Monorepo de automações (Slack/GitHub/Linear) | produto, não harness; fora do escopo |
| Electron wrapper que baixa `uv`/`node` | nosso app já é Electron e não empacota Python |
| Settings de LLM/cloud/MARS | específicos do provedor deles |
| Testes E2E com mock-llm em Docker | infra pesada; nosso `ui-work.cjs` já cobre |

## 12. Modelo de exemplo para o nosso harness

Padrão a copiar: **o loop vive no core, a UI consome um stream ordenado e
retomável**. Concretamente:

1. `AgentEvent` com `seq` monotônico e `id` estável; o core expõe
   `subscribe(afterSeq)` e a UI guarda o último `seq` por sessão. Reconexão
   pede `afterSeq`, nunca "tudo de novo".
2. `DeltaBatcher` no renderer: acumula tokens, aplica em
   `requestAnimationFrame`, e `flush()` obrigatório antes de `tool_start`,
   `tool_result`, `message` e `finish`.
3. Permissão como estado de primeira classe: `awaiting_confirmation` +
   `security_risk` + `confirmationId`; a resposta carrega o id e é idempotente,
   com dedupe local (como `submittedEventIds`).
4. Compactação medida: antes/depois de `per_turn_token`, com timeout e
   mensagem de falha distinta de "nada a fazer".
5. Delegação: uma tool `launch_child` cujo texto ensine (a) brief autocontido,
   (b) isolamento por worktree vs compartilhado, (c) resultado assíncrono por
   mensagem prefixada — exatamente o contrato de
   `launch-child-conversation-client-tool.ts:14-59`.
6. Fork por evento, com `parentEventId`, para "editar e reenviar" sem perder a
   linhagem.

Teste: um teste de contrato que falhe se o renderer chamar o servidor fora da
camada de API (equivalente a `no-direct-agent-server-calls.test.ts`) e um teste
de propriedade do batcher (nunca emite fora de ordem, sempre faz flush).

## 13. Evidências da análise

```text
git -C repositorios/_research/agents/All-Hands-AI--OpenHands rev-parse HEAD
  → b185939d3dec3b203b0651c675f175ee5b4ed43e
Get-ChildItem src -Recurse -Include *.ts,*.tsx | Measure-Object -Line
  → 1462 arquivos, ~177.121 linhas
Get-Content package.json            → name @openhands/agent-canvas, bin agent-canvas
Get-Content bin/agent-canvas.mjs    → "Agent-server via uvx" (linha 6)
Get-Content electron/main.mjs       → "Starts the full Agent Canvas stack ... via uvx" (linhas 4-5)
Get-Content config/defaults.json    → agentServer 1.58.1, mínimo 1.55.0 (linhas 4-9)
Select-String conversation-websocket-context.tsx -Pattern "batcher|after_seq"
  → 255-267 (dois batchers), 1142-1151 (resume), 1189 (onMessage)
Get-Content streaming-delta-batcher.ts → 29-57 (commit por animation frame)
Get-Content use-websocket.ts           → 25-27 (backoff 1s..30s), 69-72 (watchdog)
Get-Content conversation-confirmation-buttons.tsx → 30-59 (dedupe + respond)
Get-Content use-await-context-compaction.ts       → 6-9 (timeouts), 71-100
Get-Content use-fork-conversation.ts              → 38-68 (fork por evento)
Get-Content launch-child-conversation-client-tool.ts → 14-59 (contrato de delegação)
Get-Content src/types/agent-server/core/base/action.ts → 8-127 (catálogo de ações)
Get-ChildItem src -Recurse -Filter *.test.ts* → 69 arquivos
Get-ChildItem tests -Recurse -Filter *.spec.ts* → 31 arquivos
```
