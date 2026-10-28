# Zed

| Campo | Valor |
|---|---|
| Repositório | https://github.com/zed-industries/zed |
| Clone local | `repositorios/_research/desktop-ui/zed-industries--zed` |
| Commit | `347f171a3fd00a3b672382d78348b37bd969d17c` |
| Licença | **GPL-3.0-or-later** na maior parte; **Apache-2.0** em crates marcados (`README.md:32`; `LICENSE-GPL`; `LICENSE-APACHE`) |
| Categoria | desktop-ui (editor native + agente) |
| Stack | Rust 2024, GPUI (GPU UI), alacritty_terminal, SQLite (sqlez), WASM extensions; Cargo (`Cargo.toml:275-278`) |
| Tamanho | 4.382 arquivos; ~1,72 milhão de linhas (`.rs` ~1,64 milhão), 251 crates |

## 1. O que é (verificado no código)

Zed é um **editor de código nativo, colaborativo e com agente integrado**, escrito
em Rust sobre o GPUI (framework de UI imediata com GPU). O binário se chama `zed`
e a versão deste clone é `1.27.0` (`crates/zed/Cargo.toml:1-8`). O entrypoint é
`crates/zed/src/main.rs:1-80`: inicializa `Application`, crash handler, settings,
tema, `MultiWorkspace`, o painel de agente (`AgentPanel`) e o servidor de
extensões.

O produto tem quatro blocos: (a) editor/workspace com buffers, multibuffer,
folding, inlay hints e LSP; (b) terminal com PTY e `alacritty_terminal`; (c) painel
de agente com ferramentas nativas e ACP (Agent Client Protocol) para agentes
externos; (d) colaboração (crates `collab`, `rpc`, `livekit`).

**Licença é o ponto crítico.** O README diz “licensed primarily under
GPL-3.0-or-later, with Apache-2.0 components where marked” (`README.md:32`). A
contagem por `Cargo.toml` é: **207 crates GPL-3.0-or-later, 36 Apache-2.0 e 8 sem
campo `license`**. Os crates de editor, terminal, project panel, agente, rope,
diff e LSP são GPL. Os Apache são basicamente `gpui*`, `util`, `path`,
`collections`, `sum_tree`, `watch`, `http_client`, `extension_api`, `cloud_*` e
`zlog`. Não se copia código GPL para o Openclod (MIT/Apache); só ideias e
comportamento, com implementação independente.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `cargo run -p zed` | `crates/zed/Cargo.toml:1-8` | compila e abre o editor |
| `script/bootstrap` | `script/bootstrap` | instala toolchain/dependências de build |
| `script/clippy` | `script/clippy` | lint Rust com regras do workspace |
| `script/bundle-mac`, `bundle-linux`, `bundle-windows.ps1` | `script/` | empacota por plataforma |
| `script/check-licenses` | `script/check-licenses` | valida licenças de dependências |
| `zed <path>` | `crates/cli/src/main.rs:98-108` | abre arquivo/diretório |
| `zed --foreground` | `crates/cli/src/main.rs:59-60` | roda em foreground com logs |
| `zed --diff <path>` | `crates/cli/src/main.rs:205` | abre diff de um arquivo |
| `zed --wait` | `crates/cli/src/main.rs:68-71` | espera fechar a janela |
| `cargo test -p editor` | `crates/editor/src/editor_tests.rs:1` | suíte gigante do editor |

A superfície de UX é de app desktop: atalhos, command palette, painéis, menus
nativos, terminal integrado, LSP, debugger (DAP), REPL e agente. O CLI é fino
(`crates/cli/src/cli.rs`), só abre caminhos e faz `--askpass`.

## 3. Arquitetura e fluxo

```text
main.rs
  → Application (GPUI) + SettingsStore + ThemeRegistry
  → MultiWorkspace → Workspace → Project
  → Worktree/Buffer → Editor (display map, selections, LSP)
  → AgentPanel → Thread (agent nativo) | ACP (agente externo)
  → tools (fs, terminal, search, LSP, MCP) → permissão → execução
  → SQLite (db.sqlite) para workspace, threads e kvp
```

- Entry point: `crates/zed/src/main.rs:1-80`.
- UI: `Application::run` em `crates/gpui/src/app.rs:278-306`; o loop de frame é
  do GPUI, não do app.
- Workspace/projeto: `crates/workspace/src/workspace.rs:1`; `Project` agrega
  worktrees e buffers.
- Editor: `crates/editor/src/editor.rs:1-120` (13.331 linhas); display map em
  `crates/editor/src/display_map.rs:1-120` (4.981 linhas).
- Terminal: `crates/terminal/src/terminal.rs:1-80` envolve `alacritty_terminal`
  (`AlacrittyTerm`, `open_pty`, `spawn_event_loop`).
- Agente: `crates/agent/src/thread.rs:900-999` (eventos de thread e permissão);
  `crates/agent/src/tools.rs:1-30` (30 módulos de ferramentas).
- ACP: `crates/agent_servers/src/acp.rs:123-200` conecta a um agente externo e
  negocia versão v1/v2.
- Persistência: `crates/db/src/db.rs:126-138` (SQLite, WAL, busy_timeout 500 ms).

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Editor multi-buffer | `crates/editor/src/editor.rs:1-120` | edição, seleção, folding, inlay hints | baixo |
| Terminal PTY | `crates/terminal/src/terminal.rs:1-80` | shell com alacritty VT e scrollback | médio |
| Painel de projeto | `crates/project_panel/src/project_panel.rs:139-430` | árvore, git status, drag/drop, rename/delete | médio |
| Git | `crates/git/src/git.rs:1` | status, diff, commit, branch | médio |
| Diff de buffer | `crates/buffer_diff/src/buffer_diff.rs:20-110` | hunks com `imara_diff` + `sum_tree` | baixo |
| Streaming diff | `crates/streaming_diff/src/streaming_diff.rs:114-276` | diff incremental de texto gerado | baixo |
| Ferramentas do agente | `crates/agent/src/tools.rs:1-30` | read/write/edit/grep/terminal/LSP/MCP/skills | alto |
| `edit_file` com streaming | `crates/agent/src/tools/edit_file_tool.rs:107-230` | edita enquanto o modelo gera | alto |
| Permissões de ferramenta | `crates/agent/src/tool_permissions.rs:10-129` | deny hardcoded + regras do usuário | alto |
| Sandbox de terminal | `crates/agent/src/sandboxing.rs:1-100` | política de fs/rede por thread | alto |
| ACP | `crates/agent_servers/src/acp.rs:123-200` | conecta Claude/Codex/Gemini etc. | alto |
| Context servers (MCP) | `crates/context_server/src/client.rs:182-201` | stdio/HTTP para MCP | alto |
| Edit prediction | `crates/edit_prediction/src` | previsão de edição por modelo | médio |
| Colaboração | `crates/collab/src` | canais, RPC, LiveKit | alto (rede) |

## 5. Loop do agente, contexto e streaming

Zed tem **dois caminhos**: o agente nativo (`crates/agent`) e o ACP
(`crates/agent_servers` + `crates/acp_thread`). O loop nativo:

1. `Thread` monta mensagens e o system prompt a partir de templates
   (`crates/agent/src/templates/system_prompt.hbs`; `thread.rs:4621-4642`).
2. O modelo responde em stream; o texto vira `AgentText` e as chamadas viram
   `ToolCallUpdate` (`thread.rs:900-916`).
3. Cada ferramenta pede permissão via `ToolPermissionContext`, com escopo
   `ToolInput`, `SymlinkTarget` ou `AgentSkills`
   (`thread.rs:926-960`). O usuário escolhe allow/deny/once/always.
4. `edit_file` usa `EditSession` e um **StreamingFuzzyMatcher**: o modelo pode
   emitir o trecho em pedaços; o matcher acha o melhor range com custo
   substituição=1, inserção=3, deleção=10 e para após 2 matches exatos
   (`streaming_fuzzy_matcher.rs:4-9`).
5. O resultado é revisado como diff (`acp_thread/src/diff.rs:28-110`) e aplicado
   no buffer; o `ThreadEvent::Stop` encerra o turno (`thread.rs:915`).
6. Compactação: `acp_thread/src/compaction.rs:1-131`; o evento
   `ContextCompaction` informa o progresso (`thread.rs:913-914`).

No ACP, Zed é o **cliente**: `connect` inicia o processo do agente, negocia
`protocol_version` v1/v2 e delega o loop ao agente externo
(`agent_servers/src/acp.rs:123-200`). O Zed só renderiza updates e aprova
permissões. O `AgentConnection` define `new_session`, `load_session`,
`close_session` e `prompt` (`acp_thread/src/connection.rs:95-147`).

Não há “contexto” no sentido de RAG: o agente recebe arquivos citados, resultados
de ferramenta e o system prompt; a compactação é feita pelo agente/ACP.

## 6. Sessões, estado e persistência

- Banco único `db.sqlite` com WAL, `busy_timeout=500`, `synchronous=NORMAL` e
  migrações por domínio (`crates/db/src/db.rs:126-138`; `:45-80`).
- Workspace: `WorkspaceDb` serializa panes, itens, docks e window bounds
  (`crates/workspace/src/persistence.rs:79-141`).
- Terminal: `terminal_view/src/persistence.rs:27-80` serializa o pane group e
  **pula terminais com task rodando** (`:63-74`), para não restaurar processo
  morto.
- Agente: `crates/agent/src/thread_store.rs` guarda threads; `acp_thread` guarda
  sessões remotas.
- KVP: `crates/db/src/kvp.rs` para chaves globais.
- Não há “checkpoint” de arquivos como o nosso (não encontrado); o undo do editor cobre edições e
  o diff do agente é revisado antes de aplicar.

## 7. Configuração e extensibilidade

- `settings.json` global + local do projeto, com `SettingsStore` e merge
  (`crates/settings/src/settings_store.rs:154-160`); `assets/settings/default.json`
  define defaults.
- Extensões em WASM (`crates/extension_host`, `crates/extension_api`); o host é
  GPL, a API é Apache-2.0.
- Temas, keymaps, snippets e grammars são arquivos/extension points.
- Agente: perfis (`write`, `ask`) com allowlist de ferramentas; adicionar uma
  ferramenta no `tools!` não basta, ela precisa estar no perfil e na UI de
  permissões (`crates/agent/src/tools.rs:184-199`).
- MCP: “context servers” com transporte stdio ou HTTP e `MCP-Protocol-Version`
  (`crates/context_server/src/client.rs:182-201`, `:512-520`).
- Skills: `crates/agent/src/tools/skill_tool.rs` carrega skills do workspace.
- Feature flags: `crates/feature_flags` controla sandbox, edit prediction etc.

## 8. Permissões, sandbox e erros

| Controle | Evidência | Comentário |
|---|---|---|
| Deny hardcoded de shell | `tool_permissions.rs:10-129` | `rm -rf /`, `~`, `$HOME`, `.`, `..`; não pode ser sobrescrito |
| Parse de subcomandos | `tool_permissions.rs:303-429` | `cargo build && rm -rf /` é analisado por comando |
| Ordem deny > confirm > allow | `tool_permissions.rs:208-313` | regra mais restritiva vence |
| Escopo de symlink | `thread.rs:933-955` | aprovar um path não aprova o alvo do symlink |
| Sandbox por thread | `sandboxing.rs:1-100` | fs/rede, com política explícita; “unsandboxed” é variante |
| Limite no Windows | `terminal_tool.rs:124-128` | sandbox Windows é Bubblewrap via WSL; rede por host não é suportada |
| Erros de permissão | `thread.rs:73-75` | follow-up do usuário nega a tool call pendente |
| Segredos | `tool_permissions.rs:11-17` | regras contra interpolação em comandos protegidos |

O sandbox do Zed é **opt-in por feature flag** e depende de integração do SO:
macOS Seatbelt, Linux Bubblewrap, Windows via WSL (`sandboxing.rs:20-23`). Em
plataforma sem integração, o wrap é no-op e o comando roda com as permissões do
agente (`sandboxing.rs:21-23`). Isso é uma limitação importante: não é um
sandbox universal.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Editor | `crates/editor/src/editor_tests.rs` (51.045 linhas) | edição, seleção, multibuffer, folding, LSP |
| Agente | `crates/agent/src/tests/*` | ferramentas, permissões, edição |
| Evals de edição | `crates/agent/src/tools/evals/fixtures/*` | `edit_file` contra diffs reais |
| ACP | `crates/agent_servers/src/e2e_tests.rs` | handshake, sessão, updates |
| Terminal | `crates/terminal/src/*` e `terminal_view` | VT, seleção, persistência |
| Banco | `crates/db/src/db.rs:335-380` | migrações e domínios |

A qualidade é de produto grande: testes de comportamento no editor, fixtures de
eval para edição e e2e de ACP. O custo de portar é alto porque quase tudo é GPL e
Rust; o valor é o **padrão de segurança e de edição**, não o código.

## 10. O que vale portar

> **Regra:** tudo marcado “GPL (ideia)” deve ser reimplementado do zero, a partir
> do comportamento documentado aqui. Não copie trechos, nomes de structs internas
> nem comentários. Só os itens “Apache-2.0 (código)” podem ser portados com aviso
> de copyright.

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| `EditSession` com matching exato + fuzzy e revisão por diff | `edit_file_tool.rs:107-230`; `streaming_fuzzy_matcher.rs:4-9` | nosso `edit` só aceita `old_string` único; o fuzzy reduz falha de modelo e o diff dá controle | GPL (ideia) | `src/core/edit/session.ts` | 21 |
| Deny hardcoded + parse de subcomandos + precedência | `tool_permissions.rs:10-129`, `:208-313` | nosso `checkCommand` é regex no comando inteiro; não vê `&&`/`;`/pipe | GPL (ideia) | `src/core/security/shell-policy.ts` | 20 |
| Permissão com escopo de symlink | `thread.rs:933-955` | aprovar `/proj/link` não deve aprovar `/home/user/.ssh` | GPL (ideia) | `src/core/security/permissions.ts` | 19 |
| Política de sandbox por thread (fs/rede) | `sandboxing.rs:1-100` | nosso shell roda com o ambiente do usuário; falta um “modo restrito” explícito | GPL (ideia) | `src/core/sandbox/policy.ts` | 18 |
| Suporte a ACP para agentes externos | `agent_servers/src/acp.rs:123-200`; `acp_thread/src/connection.rs:95-147` | permite plugar Claude/Codex/Gemini sem reimplementar o loop | GPL (ideia; protocolo externo) | `src/core/agents/acp.ts` | 17 |
| Restauração de layout que ignora terminal rodando | `terminal_view/src/persistence.rs:63-80` | evita “ressuscitar” processo morto ao reabrir o app | GPL (ideia) | `src/core/session/layout.ts` | 15 |
| Diff por palavra/hunk com `imara_diff` | `buffer_diff.rs:20-110` | nosso diff é linha a linha; falta word-level para revisão | GPL (ideia; `imara_diff` é dependência externa) | `src/renderer/src/components/ChangesPane.tsx` | 15 |
| `sum_tree` para virtualização | `crates/sum_tree/src/sum_tree.rs:1` | bom para transcript/árvore grande, mas exige porte TS cuidadoso | Apache-2.0 (código) | `src/renderer/src/lib/sum-tree.ts` | 14 |
| SQLite com WAL e migrações por domínio | `crates/db/src/db.rs:45-80`, `:126-138` | nosso store é JSON atômico; SQLite ajudaria em histórico grande | GPL (ideia) | `src/core/store/sqlite.ts` | 13 |
| GPUI (UI imediata/GPU) | `crates/gpui/src/app.rs:278-306` | referência de arquitetura, não portável para React | Apache-2.0 (código) | não propor | 7 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| `crates/editor`, `rope`, `buffer_diff`, `streaming_diff` | **GPL-3.0-or-later**; copiar contaminaria o app |
| `crates/terminal`, `terminal_view` | GPL; além disso é Rust + alacritty, não Electron |
| `crates/agent`, `agent_ui`, `acp_thread` | GPL; só as ideias de permissão/edição são aproveitáveis |
| `crates/project_panel`, `git`, `git_ui` | GPL; nosso explorer é React e menor |
| `crates/collab`, `rpc`, `livekit` | GPL e infraestrutura de servidor; não temos colaboração |
| GPUI como framework | Apache, mas Rust e incompatível com Electron/React |
| `alacritty_terminal` wrapper | já usamos xterm.js; trocar seria regressão de integração |
| 8 crates sem `license` | ambiguidade jurídica; evitar até esclarecer |

## 12. Modelo de exemplo para o nosso harness

Implementação **clean-room** das ideias, sem código GPL:

1. **`src/core/edit/session.ts`**: uma sessão de edição que aceita `{ path,
   oldText, newText, replaceAll }`; primeiro tenta match exato; se falhar, um
   matcher por linhas com custo (substituição 1, inserção 3, deleção 10) e
   limite de 2 candidatos; sempre devolve `{ range, confidence, diff }` para a UI
   revisar. Nada é escrito sem `apply`.
2. **`src/core/security/shell-policy.ts`**: parser de shell (usar `shell-quote`
   ou um tokenizer próprio) que separa `&&`, `||`, `;`, `|`, subshell e
   redirecionamento; aplica deny hardcoded em **cada** subcomando e regras
   `always_deny` > `always_confirm` > `always_allow`. Bloquear `$VAR`, backticks,
   `$(...)`, `<(...)` e `>(...)` em comandos que exigem aprovação.
3. **`src/core/security/permissions.ts`**: adicionar `scope: 'input' | 'symlink'
   | 'skill'` ao `PermissionRequest`; a aprovação de symlink é separada e mostra
   o alvo real (`realpath`).
4. **`src/core/sandbox/policy.ts`**: política por sessão `{ read: roots, write:
   roots, network: hosts|none, gitMetadata: readonly }`; no Windows, declarar
   explicitamente “sem sandbox de rede” em vez de fingir que há.
5. **ACP**: um cliente JSON-RPC 2.0 por stdio com `initialize`, `session/new`,
   `session/prompt`, `session/update` e `session/request_permission`; o agente
   externo roda em processo filho com job object e timeout. A UI só renderiza
   updates.
6. **Teste**: fixtures de edição (arquivo com trecho ambíguo, indentação
   diferente, CRLF), comandos com `&& rm -rf /`, symlink para `.ssh`, e um fake
   ACP server que pede permissão e envia um diff.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/desktop-ui/zed-industries--zed rev-parse HEAD
347f171a3fd00a3b672382d78348b37bd969d17c

$ grep -n "license" crates/zed/Cargo.toml
license = "GPL-3.0-or-later"

$ grep -h '^license' crates/*/Cargo.toml | sort | uniq -c
207 license = "GPL-3.0-or-later"
 36 license = "Apache-2.0"
  8 (sem campo)

$ sed -n '1,24p' crates/agent/src/sandboxing.rs
macOS (Seatbelt), Linux (Bubblewrap), Windows (Bubblewrap via WSL)...
"on platforms without one the per-command wrap is a no-op"

$ sed -n '4,9p' crates/agent/src/tools/edit_session/streaming_fuzzy_matcher.rs
REPLACEMENT_COST = 1; INSERTION_COST = 3; DELETION_COST = 10; MAX_EXACT_MATCHES = 2

$ sed -n '10,40p' crates/agent/src/tool_permissions.rs
HardcodedSecurityRules { terminal_deny: [rm -rf /, ~, $HOME, ., ..] }

$ sed -n '926,960p' crates/agent/src/thread.rs
ToolPermissionContext { tool_name, input_values, scope: ToolInput | SymlinkTarget | AgentSkills }

$ sed -n '126,138p' crates/db/src/db.rs
PRAGMA foreign_keys=TRUE; journal_mode=WAL; busy_timeout=500; synchronous=NORMAL

$ sed -n '63,80p' crates/terminal_view/src/persistence.rs
if terminal.task().is_some() { None } else { serialize item }
```

Limitações: não compilei o Zed (toolchain Rust pesada) nem rodei os testes. A
contagem de licenças é textual sobre `crates/*/Cargo.toml`; 8 crates internos não
declaram licença e devem ser tratados como GPL por padrão ou evitados.
