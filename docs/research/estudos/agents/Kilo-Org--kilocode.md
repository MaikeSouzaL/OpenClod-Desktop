# Kilo Code

| Campo | Valor |
|---|---|
| Repositório | https://github.com/Kilo-Org/kilocode |
| Clone local | `repositorios/_research/agents/Kilo-Org--kilocode` |
| Commit | `9723be621429771ea47a2614b0ac433448023cec` |
| Licença | MIT (`LICENSE:1-3`) |
| Categoria | agents (CLI + VS Code + JetBrains, fork de opencode) |
| Stack | TypeScript + Bun 1.4.4 + Effect + SolidJS/OpenTUI + Drizzle/SQLite + `ai` SDK + Turbo; 35 pacotes |
| Tamanho | 11.030 arquivos; `packages/opencode/src` com 946 `.ts/.tsx` e ~175 mil linhas; 827 testes em `opencode` e 185 em `core`; 3.517 marcadores `kilocode_change` |

## 1. O que é (verificado no código)

É um **fork do opencode** rebrandeado, com CLI/TUI, extensão VS Code e
JetBrains no mesmo monorepo (`packages/opencode`, `packages/kilo-vscode`,
`packages/kilo-jetbrains`, `packages/tui`, `packages/ui`). O produto se chama
`@kilocode/kilo` (`package.json:3`), o binário CLI é `kilocode`
(`packages/opencode/package.json:19-21`) e o núcleo é servido por um daemon
local com SQLite (Drizzle) e API HTTP/ACP.

A marca do fork está no código: 3.517 comentários `kilocode_change` dentro de
`packages/opencode/src`, isto é, o upstream é patchado **inline** em vez de por
plugins. O README promete VS Code, JetBrains e CLI (`README.md:20-21`), o que
confere com os pacotes; já o "web UI" foi deliberadamente removido
(`packages/opencode/src/index.ts:9`).

Diferente do Cline/Roo antigo, não há `src/` na raiz: tudo vive em `packages/`.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `bun run dev` | `package.json:9` | CLI em modo dev (`KILO_CLIENT=cli`) |
| `bun run build` | via turbo, `turbo.json` | build dos pacotes |
| `bun run typecheck` | `package.json:15` | typecheck por pacote |
| `bun run lint` | `package.json:12` | oxlint |
| `bun run extension` | `package.json:22` | sobe a extensão VS Code |
| `bun run check:architecture` | `package.json:13` | regras de dependência entre pacotes |
| `bun test` (por pacote) | `packages/opencode/package.json:10` | runner próprio (`script/test-runner.ts`) |
| `kilocode` | `packages/opencode/package.json:19-21` | CLI |
| `kilocode run` | `src/cli/cmd/run.ts` | execução não interativa |
| `kilocode acp` | `src/cli/cmd/acp.ts` | agente via Agent Client Protocol |
| `kilocode serve` | `src/cli/cmd/serve.ts` | daemon HTTP |
| `kilocode agent` | `src/cli/cmd/agent.ts` | gerencia agentes |
| `kilocode mcp` / `models` / `providers` | `src/cli/cmd/{mcp,models,providers}.ts` | configuração |
| `kilocode pr` / `github` | `src/cli/cmd/pr.ts`, `github.ts` | integração GitHub |
| `kilocode export` / `import` | `src/cli/cmd/export.ts`, `import.ts` | portabilidade de sessão |
| `kilocode db` | `src/cli/cmd/db.ts` | migrações/inspeção do SQLite |
| `kilocode attach` / `remote` | `src/cli/cmd/attach.ts`, `remote.ts` | conecta a daemon existente |

A UI de terminal é `packages/tui` (OpenTUI/Solid) e a de IDE é
`packages/kilo-vscode` + `packages/kilo-web-ui`. Não há slash commands num
arquivo único: eles vêm de `BUILTIN_COMMANDS`
(`packages/opencode/src/kilocode/session/builtin-commands.ts`), importado pelo
loop em `packages/opencode/src/session/prompt.ts:29`.

## 3. Arquitetura e fluxo

```
bin/kilo → src/index.ts (yargs) → comando (run|serve|tui|acp)
  → SessionPrompt.prompt → while(true) (prompt.ts:1555)
  → SessionProcessor.process (stream LLM) → ToolRegistry → tools
  → Permission.ask → Snapshot (git) → SQLite/JSON storage
```

- Entry point: `packages/opencode/src/index.ts:1-21`; CLI em `src/cli/`.
- Loop do agente: `packages/opencode/src/session/prompt.ts:1555` (`while (true)`);
  processamento de um passo em `session/processor.ts:41-67`.
- Execução de ferramenta: `src/tool/registry.ts:1-60` (imports) e
  `src/tool/tool.ts` (contrato `Tool.define`).
- Streaming: `session/processor.ts` consome `LLM.StreamInput` e devolve
  `"compact" | "stop" | "continue"` (`:42`).
- Persistência: SQLite via Drizzle (`packages/core/src/session/sql.ts`,
  `packages/core/src/database`) + storage em arquivos
  (`src/storage/storage.ts:22-40`).

## 4. Catálogo de ferramentas / capacidades

Registro em `packages/opencode/src/tool/registry.ts:1-60`; cada tool é um
`Tool.define` com schema e descrição em `.txt` separado.

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| `read` | `src/tool/read.ts`, `read.txt` | leitura com numeração de linha | baixo |
| `edit` | `src/tool/edit.ts:1-60`; `edit.txt:1-10` | substituição exata, exige leitura prévia, preserva CRLF/BOM | médio |
| `write` | `src/tool/write.ts` | escrita de arquivo novo/sobrescrita | médio |
| `apply_patch` | `src/tool/apply_patch.ts:22-45`; `apply_patch.txt` | patch multi-hunk | médio |
| `shell` | `src/tool/shell.ts:1-50` | shell com detecção de comando que altera arquivos | alto |
| `grep` / `glob` | `src/tool/grep.ts`, `glob.ts` | busca (ripgrep) | baixo |
| `task` (subagente) | `src/tool/task.ts:36-60`; `task.txt:1-19` | delega, com `background` e `task_id` para retomar | alto |
| `skill` | `src/tool/skill.ts` | carrega skill | médio |
| `plan_enter` / `plan_exit` | `src/tool/plan.ts` (reexporta `kilocode/tool/plan`) | troca de modo plan | baixo |
| `todowrite` | `src/tool/todo.ts` | lista de tarefas | baixo |
| `lsp` / `diagnostics` | `src/tool/lsp.ts`, `diagnostics.ts` | símbolos e diagnósticos | baixo |
| `question` | `src/tool/question.ts` | pergunta ao usuário | baixo |
| `webfetch` / `websearch` | `src/tool/webfetch.ts`, `websearch.ts` | rede | médio |
| `repo_clone` | `src/tool/repo_clone.ts` | clona repositório | médio |
| code mode | `src/tool/code-mode.ts` | executa script orquestrando tools | alto |
| MCP tools | `src/mcp/*` | ferramentas externas | alto |

## 5. Loop do agente, contexto e streaming

O loop é um `while (true)` que recalcula o estado a partir das mensagens
persistidas a cada volta (`prompt.ts:1555-1570`). Três detalhes valiosos:

1. **Orfandade**: se a última mensagem do assistente tem tool calls mas o
   provider devolveu `stop`, o loop continua para enviar os resultados
   (`:1591-1597`); tool part interrompida é ignorada, não reexecutada.
2. **`plan_exit` é parada dura** antes de nova chamada ao modelo
   (`:1599-1613`), com pergunta de follow-up ao usuário.
3. **Compactação com teto de tentativas** por turno (`:1549`, `:1674-1687`),
   evitando loop infinito de "compacta → ainda estoura".

O primeiro passo usa `MAX_STEPS_PROMPT` quando o agente atinge o limite de
passos: o modelo é instruído a responder só texto, sem ferramentas
(`packages/core/src/session/runner/max-steps.ts:1-16`). Isso é melhor que
matar o turno: preserva um resumo útil.

`SessionProcessor` detecta "doom loop" com `DOOM_LOOP_THRESHOLD = 3`
(`processor.ts:41`) e retorna `compact | stop | continue` (`:42`).

Compaction: poda resultados antigos com `PRUNE_MINIMUM = 20_000`,
`PRUNE_PROTECT = 40_000`, corte de 2 000 chars por resultado e janela recente
entre 2 000 e 15 000 tokens (`compaction.ts:40-45`); o resumo usa
`buildPrompt` de `@opencode-ai/core/session/compaction`
(`compaction.ts:35`).

## 6. Sessões, estado e persistência

Sessões, mensagens e partes ficam em SQLite (Drizzle) com migrações
(`src/cli/cmd/db.ts`; `packages/core/src/session/sql.ts`), além de um storage
de arquivos versionado (`src/storage/storage.ts:22-40`: root, session,
message, diff). `export`/`import` tornam a sessão portátil
(`src/cli/cmd/export.ts`, `import.ts`).

Snapshots são **git-based**: `src/snapshot/index.ts` mantém um repositório
paralelo, com `MAX_DIFF_SIZE = 256 KiB`, retenção de 7 dias e `Patch` com
`hash` + arquivos (`:28-31`, `:45-57`). `session/revert.ts:16-27` expõe
`revert`/`unrevert` por `messageID`/`partID`, ou seja, desfazer até um ponto
da conversa **e** do workspace. Worktrees têm serviço próprio
(`src/worktree/index.ts:25-38`) com limpeza de PTYs ao remover.

## 7. Configuração e extensibilidade

- Agentes como dados: `Info` com `mode: subagent|primary|all`, `permission`
  (Ruleset), `model`, `variant`, `steps`, `prompt`
  (`src/agent/agent.ts:40-65`); agentes podem ser gerados por LLM
  (`GeneratedAgent`, `:68+`).
- Plugins: `packages/plugin`, `packages/plugin-atomic-chat`, e tools de plugin
  entram no mesmo registry (`registry.ts:26-30`).
- Skills: `packages/core/src/skill` + `src/skill`; comandos embutidos em
  `kilocode/session/builtin-commands.ts`.
- MCP: `src/mcp` (cliente, transporte, pool) com escopo por sessão/workspace.
- ACP: `src/acp` + `packages/sdk`/`sdk-next`.
- LSP e formatadores: `src/lsp`, `src/format/index.ts:15-26` (autoformata o
  arquivo após editar, por extensão).
- Índice semântico: `packages/kilo-indexing`; memória: `packages/kilo-memory`.

## 8. Permissões, sandbox e erros

Modelo declarativo `{action, resource, effect}` com `effect: allow|deny|ask`,
wildcards e regras por agente (`packages/schema/src/permission.ts:54-64`;
`agent.ts:54`). A resposta do usuário é `once | always | reject`
(`permission.ts:40`), e há um terceiro caminho: **correção com feedback** —
`CorrectedError` carrega `feedback` e a mensagem devolvida ao modelo explica o
motivo (`packages/core/src/v1/permission.ts:13-19`). `DeniedError` inclui o
ruleset relevante (`:21-27`).

A avaliação é feita por `Permission.ask`, que devolve `AskOutcome` com a regra
vencedora (`packages/opencode/src/permission/index.ts:66-77`), permitindo à UI
explicar *por que* auto-aprovou. Há `AllowEverythingInput` por sessão
(`:59-63`) e `saveAlwaysRules` (`:53-57`).

Para shell, a permissão usa **aridade de comando**: `permission/arity.ts:1-9`
reduz `git commit -m x` a `git commit` (flags não contam), o que evita regras
frágeis por string inteira. O shell também detecta `cd`/`rm`/`mv` para marcar
mutação (`tool/shell.ts:36-50`) e bloqueia caminhos externos ao projeto
(`tool/external-directory.ts:24-30`).

Sandbox: `packages/kilo-sandbox` e `@anthropic-ai/sandbox-runtime`
(`package.json:37`); há política por workspace (`kilocode/sandbox/policy`).
Erros são `Schema.TaggedErrorClass` (reject/correct/deny/not-found), com
mensagens prontas para o modelo.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| opencode (827 arquivos) | `packages/opencode/**/*.test.ts` | sessão, tools, permissões, snapshot |
| core (185) | `packages/core/**/*.test.ts` | schema, sessão, runner |
| Runner próprio | `packages/opencode/script/test-runner.ts` | execução isolada por pacote |
| Unit de scripts | `package.json:27` | `bun test ./script` |
| Arquitetura | `script/check-architecture.ts` | proíbe dependência cruzada |
| Duplicação | `script/check-kilocode-duplication.ts` | detecta cópia do upstream |
| Lint/format | `oxlint`, `.prettierrc` | estilo |
| CI | `.github/workflows` + `.artifacts/unit/junit.xml` | JUnit por pacote |

O `check-kilocode-duplication` é sintomático: o fork se preocupa em não
duplicar o upstream, justamente porque 3.517 patches inline já dificultam o
merge.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Permissão `{action, resource, effect}` + `once/always/reject` + correção | `packages/schema/src/permission.ts:40-64`; `core/src/v1/permission.ts:13-27` | modelo mínimo, com feedback corretivo | MIT | `src/core/permissions/model.ts` | 24 |
| Aridade de comando shell | `src/permission/arity.ts:1-40` | regra estável (`git commit`) em vez de string inteira | MIT | `src/core/permissions/arity.ts` | 23 |
| Preservação de CRLF/BOM no edit | `src/tool/edit.ts:27-60` | essencial no Windows; evita diff fantasma | MIT | `src/core/tools/text-edit.ts` | 22 |
| Truncar salvando o full output | `src/tool/truncate.ts:12-40` | 2 000 linhas/50 KB + arquivo com tudo, 7 dias | MIT | `src/core/tools/truncate.ts` | 22 |
| Delegação `task` com background e retomada | `src/tool/task.ts:36-60`; `task.txt:1-19` | contrato claro de quando usar e como retomar | MIT | `src/core/tools/task.md` | 21 |
| Snapshot git + revert por mensagem | `src/snapshot/index.ts:28-57`; `session/revert.ts:16-27` | desfaz workspace e conversa juntos | MIT | `src/core/session/snapshot.ts` | 21 |
| Loop com orfandade e teto de compactação | `src/session/prompt.ts:1549-1620` | não perde tool call nem entra em loop de compactar | MIT | `src/core/agent/loop.ts` | 20 |
| `MAX_STEPS_PROMPT` | `packages/core/src/session/runner/max-steps.ts:1-16` | encerra pedindo resumo, não matando | MIT | `src/core/agent/max-steps.ts` | 19 |
| Poda de contexto com números | `src/session/compaction.ts:40-45` | política concreta e barata | MIT | `src/core/context/prune.ts` | 18 |
| Agente como dado (modo, tools, permission, steps) | `src/agent/agent.ts:40-65` | perfis sem código | MIT | `src/core/agents/profile.ts` | 17 |
| Autoformatação pós-edit | `src/format/index.ts:15-26` | consistência sem pedir ao modelo | MIT | `src/core/tools/format.ts` | 16 |
| Bloqueio de caminho externo | `src/tool/external-directory.ts:24-30` | impede edição fora do projeto | MIT | `src/core/tools/path-scope.ts` | 15 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| O fork inteiro (3.517 patches inline) | merge com upstream caro; melhor portar ideias |
| Stack Effect + Drizzle + OpenTUI/Solid | paradigma e UI incompatíveis com Electron/React |
| Daemon HTTP/ACP e `kilo-gateway` | nosso app já tem IPC e processo principal |
| VS Code/JetBrains extensions | outro host, outra vida |
| `packages/kilo-indexing` / `kilo-memory` | serviços de produto |
| Code mode (executa JS orquestrando tools) | superfície de execução extra |
| `AllowEverythingInput` global | perigoso; preferir regra por tool/prefixo |
| Testes de snapshot gigantes | portar casos, não a infraestrutura |

## 12. Modelo de exemplo para o nosso harness

Copiar **três contratos concretos**:

1. Permissão como tupla `(action, resource, effect)`, com wildcard, resposta
   `once | always | reject` e um quarto caminho de **correção com feedback** —
   o modelo recebe "negado porque X" e pode se corrigir no mesmo turno.
   Guardar a regra vencedora para a UI explicar o auto-approve.
2. Aridade de comando: normalizar `git commit -m ...` para `git commit` antes
   de casar regras. Flags nunca contam; prefixo mais longo vence. Isso resolve
   o problema de regras de shell que quebram com qualquer argumento novo.
3. Edição de texto que preserva CRLF e BOM e exige leitura prévia; truncamento
   que grava o output completo em arquivo e devolve prévia + caminho.

Para delegação, usar o `task.txt` como molde: dizer quando **não** usar,
exigir brief autocontido, permitir `background` e `task_id` para retomar, e
proibir polling do subagente.

Teste: aridade (`git -c x commit` → `git`), CRLF round-trip, permissão
`always` persistida por sessão, e revert que restaura workspace + corta a
conversa no `messageID`.

## 13. Evidências da análise

```text
git rev-parse HEAD → 9723be621429771ea47a2614b0ac433448023cec
packages/opencode/src → 946 arquivos, 175.354 linhas
opencode tests=827; core tests=185
marcadores "kilocode_change" em packages/opencode/src = 3.517
package.json:3,7,9-27 → @kilocode/kilo, bun 1.4.4, scripts
packages/opencode/package.json:10,19-21 → test runner, bin kilocode
src/index.ts:1-21 → yargs e comandos
src/session/prompt.ts:1549-1620 → loop, órfãos, plan_exit, compactação
src/session/processor.ts:41-42 → DOOM_LOOP_THRESHOLD e Result
src/session/compaction.ts:40-45 → PRUNE_MINIMUM/PROTECT/janela
src/tool/edit.ts:27-60 → CRLF/BOM/diff
src/tool/truncate.ts:12-40 → 2000 linhas/50KB, retenção 7 dias
src/tool/task.ts:36-60; task.txt:1-19 → delegação/background/resume
src/tool/apply_patch.ts:22-45 → patchText
src/snapshot/index.ts:28-57 → Patch/hash/MAX_DIFF_SIZE
src/session/revert.ts:16-27 → revert/unrevert
packages/schema/src/permission.ts:40-64 → Reply/Effect/Rule
src/permission/index.ts:59-77 → AskOutcome/AllowEverything/saveAlways
src/permission/arity.ts:1-40 → prefixo por aridade
src/agent/agent.ts:40-65 → Info do agente
```
