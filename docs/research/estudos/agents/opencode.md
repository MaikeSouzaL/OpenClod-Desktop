# OpenCode

| Campo | Valor |
|---|---|
| Repositório | https://github.com/anomalyco/opencode (`package.json:145-148`) |
| Clone local | `repositorios/opencode` |
| Commit | `0749dec67568a5a4dcc8ce42b2db5da8fe4ce6fa` |
| Licença | MIT (`LICENSE:1`, `package.json:149`) |
| Categoria | agents / harness completo (CLI + TUI + servidor HTTP + desktop) |
| Stack | TypeScript ESM, Bun 1.4.4 (`package.json:8`), Effect 4, Drizzle ORM + SQLite, SolidJS/OpenTUI, Electron |
| Tamanho | 8.617 arquivos versionados; 6.087 fontes (~1,15 M linhas); 1.227 arquivos de teste |

## 1. O que é (verificado no código)

OpenCode é um harness de agente com três frentes: um binário de CLI (`packages/cli/src/index.ts:1`),
um servidor HTTP local que guarda o estado (`serve`, `packages/cli/src/commands/commands.ts:568`) e
clientes TUI/desktop/web que falam com esse servidor (`--server`, `commands.ts:20-25`). O modelo de
execução não é um `while` com memória: cada passo é **uma chamada explícita de streaming que continua
a partir do histórico recarregado** (`packages/core/src/session/runner/llm.ts:188-192`), e a entrada do
usuário entra por uma fila durável (`session_inbox`) antes de virar mensagem visível
(`session/session.ts:155-176`). Nesta versão (2.1.4) o núcleo saiu de `packages/opencode/src` para
`packages/core/src`; qualquer estudo baseado em tutoriais antigos aponta para caminhos que não existem
mais. O README descreve o produto, mas o comportamento real de fila, retry e compactação só aparece
no código citado abaixo.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `bun run dev` | `package.json:10` | roda `packages/cli/src/index.ts` (TUI) |
| `bun run dev:desktop` | `package.json:16` | app Electron |
| `bun run test` | `package.json:49` | **falha de propósito**: testes só rodam por pacote |
| `opencode run [mensagem]` | `commands.ts:399-440` | execução não interativa, `--format json`, `--file`, `--fork` |
| `opencode serve` | `commands.ts:568-581` | sobe API v2 + web server (`--hostname`, `--port`, `--cors`, `--stdio`) |
| `opencode service start/status/stop` | `commands.ts:491-532` | gerencia o servidor de fundo e a credencial local |
| `opencode session list/delete/export/import` | `commands.ts:441-490` | ciclo de vida e portabilidade de sessão |
| `opencode mcp add/list/auth/logout` | `commands.ts:237-280` | MCP local (`-- command`) e remoto (`--url`, `--header`) |
| `opencode plugin add/update/remove` | `commands.ts:281-327` | plugins npm/Git |
| `opencode auth login/export/import` | `commands.ts:164-236` | credenciais e contas |
| `opencode debug agents/config/paths` | `commands.ts:125-163` | introspecção de agentes, fontes de config e caminhos |
| `opencode acp` | `commands.ts:99-107` | servidor Agent Client Protocol (`packages/cli/src/acp/*`) |
| `opencode upgrade/uninstall` | `commands.ts:70-98` | ciclo de instalação |

Flags globais relevantes: `--auto` (aprova o que não está negado explicitamente), `--yolo` e
`--dangerously-skip-permissions` (ocultas) em `commands.ts:36-46`; `--continue`/`-c` e `--session`/`-s`
em `commands.ts:57-66`. Slash commands de sessão não ficam no CLI: são definidos como arquivos e
resolvidos por `packages/core/src/command.ts:42-90` (`Command.execute`), com nomes vindo do schema em
`@opencode/schema/command`.

## 3. Arquitetura e fluxo

```
packages/cli/src/index.ts → commands/commands.ts (effect/cli)
  → client HTTP (@opencode/client) → packages/server (HttpApi)
    → Session.prompt (session/session.ts:155) → session.inbox.enqueued (projeção grava session_inbox)
      → SessionExecution.wake (session/execution.ts:25,169) → SessionRunCoordinator
        → SessionRunner.drain (session/runner/llm.ts:56)
          → advanceToStep → promote inbox → SessionContext.load → runStep (llm.ts:203)
            → SessionStep.attempt (runner/step.ts:73) → llm.stream + ferramentas em fibers
              → Bus (eventos) → projeção SQLite → UI
```

- Entry point: `packages/cli/src/index.ts:28-32` (mapa comando → handler dinâmico).
- Loop do agente: `packages/core/src/session/runner/llm.ts:185-193` (loop de `advanceToStep`/`runStep`).
- Execução de ferramenta: `packages/core/src/session/runner/step.ts:91-134` (cada `tool-call` vira uma
  fiber; `executeTool` recusa ferramentas quando `toolChoice === "none"`).
- Streaming: `packages/core/src/session/runner/step.ts:107-138` (`Stream.runForEach` sobre
  `llm.stream`, publicando cada `LLMEvent` no `Bus`).
- Persistência: `packages/core/src/session/sql.ts:23-84` (tabelas `session` e `session_message` via
  Drizzle/SQLite) e `session/store.ts:88-140` (leitura/ paginação).

O ponto arquitetural importante: **não existe loop de ferramentas em memória**. O comentário normativo
do repositório diz "Each step is one explicit `llm.stream` call that continues from reloaded history.
Do not add an in-memory tool loop" (`AGENTS.md`, seção Session Core). O estado do passo é reconstruído
do banco a cada iteração.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `bash` / shell | `packages/core/src/tool/plugin/shell.ts` (registro em `tool.ts:329`) | executa comando com timeout e ambiente do projeto | alto |
| `read` | `tool/plugin/read.ts:15` | lê arquivo com offset/limit e devolve linhas numeradas | baixo |
| `edit` | `tool/plugin/edit.ts:22` | substituição exata de trecho, com diff aplicado | médio |
| `write` | `tool/plugin/write.ts` | cria/sobrescreve arquivo | médio |
| `patch` | `tool/plugin/patch.ts` | aplica diff unificado | médio |
| `glob` / `grep` | `tool/plugin/glob.ts`, `grep.ts` | busca por nome e por conteúdo (ripgrep) | baixo |
| `webfetch` / `websearch` | `tool/plugin/webfetch.ts`, `websearch.ts` | HTTP e busca web | médio |
| `todo` | `tool/plugin/todo.ts` | lista de tarefas da sessão | baixo |
| `question` | `tool/plugin/question.ts` | pergunta ao usuário e **bloqueia** até resposta | baixo |
| `skill` | `tool/plugin/skill.ts` | carrega `SKILL.md` e devolve conteúdo como bloco | baixo |
| `subagent` | `tool/plugin/subagent.ts` | delega a uma sessão filha e acompanha | alto |
| `list_mcp_resources` / `read_mcp_resource` | `tool/plugin/mcp-resource.ts:19,51` | recursos MCP | médio |
| `opencode` (meta) | `tool/plugin/opencode.ts:106-220` | renomeia/move sessão, cria worktree, lista modelos | alto |

O registro é um `Map` com namespaces, validação de nome e erros acumulados
(`packages/core/src/tool.ts:35-39,161-200`); a execução real normaliza Schema → JSON Schema
(`tool/runtime.ts:22-60`) e trunca saída grande (`tool-output.ts:13-15`: 2.000 linhas / 50 KiB por
arquivo, retenção de 7 dias).

## 5. Loop do agente, contexto e streaming

**Montagem do prompt.** `runStep` monta `SessionModelRequest.baseTranscript(...)` com agente, modelo,
ferramentas, instruções iniciais e mensagens (`runner/llm.ts:222-228`); o `system` sai do transcript e
o request passa por `context.request.primary` (`llm.ts:229-242`). O limite de passos do agente entra
como uma mensagem de sistema injetada, mantendo as definições de ferramenta no prefixo para não
quebrar o cache do provedor (`llm.ts:234-239`).

**Decisão de ferramenta.** O provedor emite `tool-call`; o passo ignora `providerExecuted`
(`step.ts:122`) e cria uma fiber por chamada, com `publisher.publish` do evento `Tool.Called`
acontecendo **antes** da execução (`step.ts:123-134`). Isso dá ordem determinística por fonte sem
fila global de escrita (comentário em `step.ts:103-104`).

**Contexto e compactação.** `compaction.compact({ reason: "auto" })` roda antes de cada passo
(`llm.ts:214`) e a política vive no runner, não no passo (`step.ts:58-59`). O checkpoint é um sumário
estruturado com seções fixas — Objective, Requirements, Decisions, Work State, Next Move, Relevant
Files, Important Context (`compaction.ts:159-190`). O script de atualização é explícito sobre
precedência: "Newer history always takes precedence over the existing checkpoint" (`compaction.ts:226`).
Há `precompute` em background a 85% do teto (`compaction.ts:146-149`) e limites: `keep` de 15.000
tokens (`compaction.ts:255`), piso de reserva de 16.000 (`compaction.ts:122`), janela desconhecida
assumida como 200.000 (`compaction.ts:130`).

**Overflow e retry.** Se o provedor recusa por contexto antes de qualquer output, o passo tenta
compactar e devolve `Outcome.Compacted` sem gravar resposta (`step.ts:155-167`). Erros de transporte
podem pedir `RecoverFull` (reinício do passo inteiro) ou `Retry` com espera (`step.ts:182-204`), e
`Continue` retoma stream interrompido com mensagem sintética
(`runner/llm.ts:34-35,283-291`). O limite de output tem streak próprio: três mensagens `assistant` com
`finish` `length` viram erro terminal (`llm.ts:292-321`).

**Cancelamento.** `Effect.uninterruptibleMask` protege o fechamento do passo; ferramentas são
interrompidas via `Fiber.interruptAll` e o assistente recebe `aborted` (`step.ts:90,140-152,225`).
Interrupção de sessão ociosa é no-op — só a cadeia de posse local é alvo (regra em `AGENTS.md`).

## 6. Sessões, estado e persistência

Formato: SQLite via Drizzle, com migrações aplicadas no bootstrap e lock por caminho de arquivo
(`packages/core/src/database/database.ts:33-56`). Tabelas principais em `session/sql.ts`:
`session` (`id`, `project_id`, `parent_id`, `fork_session_id`, `fork_boundary`, `title`, tokens,
`revert`, `permission`, `agent`, `model`, tempos e `resume_attempts`, linhas 23-68) e `session_message`
(linhas 80-84). Índices por projeto/workspace/pai e tempo de suspensão (`sql.ts:71-74`).

- **Fork**: `fork_session_id` + `fork_boundary` guardam o ponto exato do fork (`sql.ts:33-34`).
- **Revert**: coluna `revert` na sessão (`sql.ts:52`) e `session/revert.ts`; o prompt comita o revert
  pendente antes de admitir trabalho novo (`session/session.ts:174-176`).
- **Move**: evento `SessionEvent.Moved` transporta a sessão entre locations
  (`runner/llm.ts:95-113`); a coluna `workspace_id` existe mas "explicit workspace identity remains
  reserved" (`AGENTS.md`).
- **Recuperação após crash**: claim write-ahead por execução; conclusão/falha/interrupção de usuário
  liberam, shutdown e morte de processo preservam (`session/execution.ts:73-79,126`). No início do
  drain, compactações e tool calls órfãs são liquidadas (`runner/llm.ts:334-387`).
- **Título**: gerado em fiber separada, sem atrasar a execução (`llm.ts:53-54,171-174`).

## 7. Configuração e extensibilidade

Precedência de config: arquivos descobertos por candidatos e o último existente vence, com fallback
`opencode.jsonc` (`packages/core/src/config.ts:387`); também são varridos diretórios de compatibilidade
com `~/.claude` e `~/.agents` (`config.ts:49,74-77`). Instruções vêm de `AGENTS.md` e equivalentes via
`instruction-discovery.ts` e `session/instructions.ts`.

- **Agentes**: `Agent.ID` default é `build`; subagentes são agentes com `mode === "subagent"`
  (`packages/core/src/agent.ts:13,75`). Cada agente carrega `steps` e um `permissions` Ruleset
  (usado em `permission.ts:145-150`).
- **Plugins**: serviço com `awaitActivation` antes de cada drain (`runner/llm.ts:69`) e hooks
  `tool.execute.before/after`, `permission.evaluate` (`tool.ts:103-149`, `permission.ts:166-175`).
- **MCP**: `packages/core/src/mcp/index.ts` mantém pilha de conexões por nome, status
  connected/needs-auth/erro e timeout de 5 s para re-listar ferramentas ao trocar de conexão
  (`mcp/index.ts:94-102`); ferramentas MCP entram no mesmo registry (`tool/mcp.ts`).
- **Skills**: `skill.ts:33-39` filtra por permissão e serializa `<skill_content name=...>`.
- **Commands**: `command.ts:42-90`, com `execute` retornando erro tipado `NotFoundError`/`ExecutionError`.
- **Code mode**: `packages/core/src/codemode/*` e catálogo em `tool.ts:10-11,158-160` (execução de
  código com ferramentas expostas como API).

## 8. Permissões, sandbox e erros

Modelo declarativo de regras `{action, resource, effect}` com wildcard. `evaluate` percorre os
rulesets e usa `findLast`, então a última regra que casar vence; sem regra, o default é `ask`
(`packages/core/src/permission.ts:74-84`). A ordem efetiva é: regras do agente (ou `*/* deny` se o
agente não declara nada) → regras da sessão → regras salvas pelo usuário, sempre tratando `deny`
primeiro (`permission.ts:19,145-165`).

`assert` bloqueia a fiber em um `Deferred` até `reply` (`permission.ts:195-254`); o decline é
"defect tunnel" — vira `Effect.die` para não ser convertido em output de ferramenta pelo
`mapError` das folhas (`permission.ts:239-244`). Já o decline **com feedback** (`CorrectedError`)
continua tipado e o modelo prossegue. `close` rejeita todas as pendências de forma uninterruptible
(`permission.ts:120-133`), e `ask` com serviço fechado devolve `deny` (`permission.ts:215`).

Sandbox de processo não é o foco aqui: o isolamento real é por regra de permissão + worktree
(`tool/plugin/opencode.ts:156-182`) e por snapshot de arquivos antes/depois do passo
(`step.ts:236-245`), que produz a lista de arquivos alterados no evento `Step.Ended`.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| unit por pacote | `packages/*/test/*.test.ts` (ex.: `packages/core/src/session/*.test.ts`) | sessão, tools, permissões, MCP |
| TUI | `packages/tui` + skill `tui-tests` | renderer OpenTUI, stories |
| app e2e | `packages/app/e2e` (Playwright, `@playwright/test` no catálogo) | fluxo web |
| component | Storybook + Playwright | componentes |
| guarda de raiz | `package.json:49` | impede `bun test` na raiz |
| lint/arch | `oxlint`, `ast-grep` (`package.json:23-31`) | padrões de Effect e imports |

O repositório proíbe mocks por padrão e exige teste da implementação real (`AGENTS.md`, "Testing").
Para o nosso harness, o valor não é copiar as suítes, e sim o hábito de teste por camada com
`fast-check` disponível no catálogo (`package.json`, catalog entry `fast-check`).

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Runner de passo único com continuação | `session/runner/llm.ts:185-332` | estado reconstruído do banco; retry/overflow/output-limit com semântica distinta | MIT | `src/core/agent/runner.ts` | 25 |
| Inbox durável com `queue`/`steer` | `session/inbox.ts:45-108`, `session/session.ts:140-176` | separa admissão de execução e permite steer sem perder ordem | MIT | `src/core/session/inbox.ts` | 24 |
| Compactação com checkpoint estruturado | `session/compaction.ts:159-231` | template fixo, regra de precedência e precompute a 85% | MIT | `src/core/agent/compaction.ts` | 24 |
| Ruleset de permissão com wildcard | `permission.ts:74-176` | `findLast`, default `ask`, merge agente+sessão+salvo | MIT | `src/core/security/permissions.ts` | 23 |
| Tool runtime com Schema→JSON Schema | `tool/runtime.ts:22-60` | valida entrada, tipa saída, achata `allOf` e inline `$ref` | MIT | `src/core/tools/runtime.ts` | 21 |
| Truncamento de saída para arquivo | `tool-output.ts:13-18` | 2.000 linhas/50 KiB + retenção de 7 dias, sem estourar contexto | MIT | `src/core/tools/output.ts` | 20 |
| Snapshot antes/depois do passo | `runner/step.ts:236-259` | lista de arquivos alterados derivada, não declarada pelo modelo | MIT | `src/core/session/snapshot.ts` | 19 |
| Recuperação de claim write-ahead | `session/execution.ts:73-79,126` | retoma turno após crash sem hook de shutdown | MIT | `src/core/session/recovery.ts` | 18 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Stack Effect 4 + `Context.Service` em tudo | nosso núcleo é TypeScript puro; reescrever o grafo de serviços seria uma migração, não um port |
| Code mode / `codemode/*` | depende de sandbox próprio e catálogo gerado; alto custo, ganho incerto |
| Servidor HTTP v2 + `@opencode/client` gerado | já temos IPC Electron; adicionar HTTP criaria segunda fonte de verdade |
| TUI OpenTUI/Solid | stack incompatível com React 19 do nosso renderer |
| `plugin/opencode.ts` (meta-ferramentas) | expõe rename/move/worktree ao modelo — superfície de risco que não precisamos agora |
| Migrações Drizzle com lock por arquivo | nosso `session/store.ts` já resolve persistência; adotar Drizzle inteiro é overkill |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto, sem inventar código:

1. **`AgentStep` como unidade explícita.** Nosso `src/core/agent/runner.ts` deve ter um único ponto
   que monta o request (histórico + system + tools) e um `for` que só decide *se* continua. Cada
   iteração relê o histórico persistido — nada de acumular mensagens em memória entre passos. Isso é
   o que o OpenCode chama de "one step is one logical LLM call" (`runner/llm.ts:202-203`).
2. **Admissão separada de execução.** Criar `src/core/session/inbox.ts` com `enqueue`, `steer`,
   `cancel`, `promote(sessionId, mode)`, e persistir antes de acordar o runner. Regra de ouro copiada
   de `inbox.ts:45-49`: `promotable: "input" | "steer"` decide o que pode ser consumido no limite.
3. **Compactação com contrato de saída.** Reutilizar o template de sete seções e a regra "histórico
   novo vence checkpoint" (`compaction.ts:159-231`). Guardar `keepID` + `tailLimit` no registro do
   checkpoint para permitir atualização incremental em vez de resumir tudo de novo.
4. **Permissões como dados.** `Rule = { action, resource, effect }`, avaliação `findLast` com wildcard,
   default `ask`, e três fontes concatenadas (agente → sessão → salvo). O teste mínimo: `deny` sempre
   vence antes de qualquer `allow`, e decline sem feedback não pode virar texto para o modelo.
5. **Truncamento de ferramenta como serviço.** Toda saída passa por `truncate()` antes de entrar no
   histórico; o arquivo completo fica em disco com expiração. Isso mantém o contexto previsível sem
   perder a evidência.
6. **Como testar.** Um teste de integração por regra: (a) steer durante passo em curso entra no próximo
   limite; (b) overflow antes de output dispara compactação e não grava resposta; (c) três `finish:
   length` seguidos falham; (d) decline com feedback mantém a sessão viva. Todos observando o banco,
   não mocks — mesma postura de `AGENTS.md`.

## 13. Evidências da análise

```text
Leitura direta (git rev-parse HEAD = 0749dec67568a5a4dcc8ce42b2db5da8fe4ce6fa):
  packages/core/src/session/runner/llm.ts:1-410
  packages/core/src/session/runner/step.ts:1-321
  packages/core/src/session/compaction.ts:155-274
  packages/core/src/session/execution.ts:1-190
  packages/core/src/session/inbox.ts:1-120
  packages/core/src/permission.ts:70-259
  packages/core/src/tool.ts:1-200
  packages/core/src/tool/runtime.ts:1-260
  packages/core/src/tool-output.ts:1-60
  packages/core/src/session/sql.ts:23-84
  packages/cli/src/commands/commands.ts:1-585

Conferências:
  git ls-files | wc -l                      -> 8617
  arquivos .ts/.tsx/.js/.rs/...             -> 6087
  linhas somadas desses arquivos            -> 1147175
  arquivos *test*/*spec*                    -> 1227
  package.json:5  "version": "2.1.4"
  package.json:8  "packageManager": "bun@1.4.4"
  package.json:149 "license": "MIT"
```

Lacunas: não abri `packages/server` (HttpApi) nem `packages/tui`; as afirmações sobre a camada HTTP
vêm do contrato de CLI (`serve`, `--server`, `service status`) e do `AGENTS.md`, não da implementação
do router. O caminho de code mode também não foi lido a fundo.
