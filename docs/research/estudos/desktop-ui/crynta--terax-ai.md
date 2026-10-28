# Terax

| Campo | Valor |
|---|---|
| Repositório | https://github.com/crynta/terax-ai |
| Clone local | `repositorios/_research/desktop-ui/crynta--terax-ai` |
| Commit | `bf7e03df0922dd6a707b916471c3eeedd962a373` |
| Licença | Apache-2.0 (`LICENSE:1-3`; `src-tauri/Cargo.toml:6`; `package.json:5`) |
| Categoria | desktop-ui (terminal-first ADE com IA) |
| Stack | Tauri 2 + Rust (`portable-pty`), React 19 + TypeScript, Vite, CodeMirror 6, Ghostty VT WASM/WebGPU, Vercel AI SDK, pnpm (`README.md:39`, `:169`) |
| Tamanho | 1.047 arquivos; ~164 mil linhas (`.ts` 90 mil, `.tsx` 29,8 mil, `.rs` 28,9 mil) |

## 1. O que é (verificado no código)

Terax é um **ambiente de desenvolvimento terminal-first com agente de IA** (o
README se descreve como “terminal-first AI-native development environment”,
`README.md:39`). O app tem: PTY nativo com
`portable-pty`, renderer de terminal Ghostty VT em WASM com WebGPU/WebGL, editor
CodeMirror 6, explorador de arquivos, source control com git graph, preview web e
um painel de IA com BYOK/modelos locais.

O processo Rust é o backend: `src-tauri/src/main.rs:1-19` chama `terax_lib::run()`,
que monta o `tauri::Builder`, plugins, o protocolo assíncrono `terax-pty`, os
`manage` de estado e o `invoke_handler` (`src-tauri/src/lib.rs:166-300`). O
frontend é React 19 (`src/main.tsx:35-37`), com a superfície de trabalho em
`src/app/components/WorkspaceSurface.tsx` (`TerminalStack`, `EditorStack`,
`FileExplorer`, `PreviewStack`).

Licença: o repo é Apache-2.0, mas o bundle inclui componentes MIT: Ghostty
(`packages/ghostty-core/LICENSE`), ghostty adaptado, restty e o WebGL derivado do
xterm.js (`src-tauri/tauri.conf.json:44-50`). É compatível com o nosso projeto,
desde que os avisos sejam preservados.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `pnpm dev` | `package.json:14` | Vite + frontend em dev |
| `pnpm build` | `package.json:16` | `tsc && vite build` |
| `pnpm tauri dev` | `package.json:18` | app Tauri em dev |
| `pnpm tauri build` | `package.json:18` | bundle de produção |
| `pnpm test` | `package.json:19` | Vitest |
| `pnpm check-types` | `package.json:24` | `tsc --noEmit` |
| `pnpm lint` | `package.json:25` | Biome |
| `pnpm bench:ghostty` | `package.json:21` | benchmark do renderer Ghostty |
| `cargo test` (em `src-tauri`) | `TERAX.md:26-30` | testes Rust |
| `terax` (CLI) | `src-tauri/crates/terax-cli` | abre workspace/arquivo via control socket |

A superfície de UX é de IDE: abas de terminal/editor/diff/preview, spaces,
command palette, explorer, source control, git history, LSP, busca e painel de
IA. O `invoke_handler` lista ~80 comandos (`src-tauri/src/lib.rs:273-330`), dos
quais os principais são `pty_*`, `fs_*`, `git_*`, `lsp_*`, `ai_*` e `control_*`.

## 3. Arquitetura e fluxo

```text
React (WorkspaceSurface)
  → Tauri invoke (comandos)         → Rust modules (fs, git, lsp, ai_sessions)
  → protocolo terax-pty (HTTP-like) → PtyHub → portable-pty → shell
  → AI SDK (streamText)             → tools (fs/edit/shell/terminal) → aprovação
  → Painel de IA / tab de diff      → CodeMirror merge
```

- Entry point Rust: `src-tauri/src/main.rs:1-19`; `run()` em `lib.rs:166`.
- Entry point React: `src/main.tsx:35-37`; composição em
  `src/app/components/WorkspaceSurface.tsx` (`TerminalStack` na linha 86,
  `EditorStack` na 100).
- PTY: `src-tauri/src/modules/pty/mod.rs:1-140` (estado, sessões, reset por
  webview, kill); `hub.rs:32-45` (keepalive e timeout); `presentation.rs:13-75`
  (classes e coalescência).
- Protocolo: `src-tauri/src/modules/pty/protocol.rs:1-120` (`POST /poll` segura
  até output due; `POST /ack` aplica crédito; CORS nomeia a origem, nunca `*`).
- Frontend do PTY: `src/modules/terminal/lib/PtyOutputHub.ts:64-80` (um long-poll
  para todos os terminais) e `PtyOutputReceiver.ts` (demux/parse).
- IA: `src/modules/ai/lib/agent.ts:363-459` (`streamText`, prune, compact,
  `stepCountIs`); ferramentas em `src/modules/ai/tools/tools.ts:16-40`.
- Editor/diff: `src/modules/editor/AiDiffPane.tsx:1-40` usa
  `@codemirror/merge` (`presentableDiff`, `unifiedMergeView`).
- Persistência: `src-tauri/src/modules/ai_sessions.rs:1-130` (um arquivo JSON
  atômico por sessão); settings via `tauri-plugin-store`.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| PTY `pty_open/write/resize/close` | `lib.rs:274-282`; `pty/mod.rs:1-140` | shell nativo por sessão | alto |
| Protocolo `terax-pty` | `pty/protocol.rs:1-120` | stream com ACK/crédito e Origin gate | alto |
| Shell integration OSC 7/133 | `pty/shell_init.rs:9-20`; `scripts/profile.ps1:1-50` | cwd, prompt boundaries, blocos | médio |
| Agent detection OSC 777 | `pty/agent_detect.rs:17-21` | detecta Claude/Codex/Gemini/OpenCode e status | médio |
| FS tree/read/write/create/rename/delete | `lib.rs:286-300`; `fs/mod.rs` | explorer completo | alto |
| FS watch + supersede | `fs/watch.rs:1-80`; `fs/supersede.rs:15-39` | invalida busca antiga, evita resultado velho | médio |
| Git status/diff/log/commit | `git/operations.rs:83-240` | source control e git graph | alto |
| LSP spawn/framing/session | `lsp/framing.rs:1-70`; `lsp/session.rs:69-150` | Content-Length, timeout, RSS budget | alto |
| AI tools (fs/edit/shell/terminal/subagent) | `src/modules/ai/tools/tools.ts:16-40` | agente com aprovação | alto |
| Diff de IA | `src/modules/editor/AiDiffPane.tsx:1-40` | merge view com aceitar/rejeitar | médio |
| Preview web | `src/modules/preview/lib/previewUrl.ts:1-23` | só loopback (`localhost`, `127.*`, `::1`) | médio |
| Controle local (CLI) | `src-tauri/src/modules/control.rs:21-32`, `:320` | socket com token e open autorizado | alto |

## 5. Loop do agente, contexto e streaming

O agente roda no **renderer** com Vercel AI SDK; o Rust só faz proxy de rede,
persistência e ferramentas locais. O fluxo:

1. `runAgentStream` converte `UIMessage[]` em `ModelMessage[]`
   (`agent.ts:389`), poda reasoning/mensagens vazias (`:391-395`) e compacta
   (`:400-407`).
2. `prepareAgentPrompt` monta system estável + prompt de plan mode + histórico
   (`:409-414`).
3. `streamText` recebe `tools: buildTools(ctx)`, `stopWhen:
   stepCountIs(MAX_AGENT_STEPS)` e `abortSignal` (`:417-424`).
4. `onStepFinish` reporta a tool call atual e tokens; `onFinish` reporta
   `hitStepCap` e `finishReason` (`:425-459`). O cap de passos é explícito, não
   infinito.
5. Ferramentas mutáveis têm `needsApproval: true`; a UI do AI SDK pausa e mostra
   o card (`tools.ts:16-26`). `edit`/`multi_edit` exigem `read_file` prévio na
   mesma sessão (`edit.ts:123-133`).
6. `edit` valida `old_string` não vazio, único (ou `replace_all`), e aplica em
   buffer; em plan mode enfileira no `planStore` em vez de escrever
   (`edit.ts:34-108`).
7. Compactação: `KEEP_TAIL = 24`, elide tool results antigos e preserva o último
   read de um path que foi mutado (`compact.ts:3-4`, `:58-110`).
8. Cancelamento: `AbortController` do AI SDK; o Rust aborta o stream e libera o
   crédito (`net/stream.rs:16-55`).

O system prompt inclui `TERAX.md` do workspace como memória (o `TERAX.md:1-4`
declara isso); não há RAG vetorial. Subagentes são ferramentas que chamam
`runSubagent` com um contexto próprio (`ai/agents/runSubagent.ts`).

## 6. Sessões, estado e persistência

- Conversa: um arquivo JSON por sessão em `ai_sessions.rs`; cada save valida o
  JSON, faz `fsync`, renomeia e sincroniza o diretório; a versão anterior vira
  `.bak`; arquivo corrompido é quarentenado e o `.bak` é tentado
  (`ai_sessions.rs:1-16`, `:101-160`, `:218-265`).
- Workspace: `WorkspaceRegistry` com roots autorizados e canonicalização;
  `LaunchDir`/`LaunchFiles` drenam o primeiro read para não repetir o diretório de
  launch (`lib.rs:15-75`).
- Abas/spaces: `useTabs.ts:30-130` define `TerminalTab`, `EditorTab`,
  `PreviewTab`, `AiDiffTab`, `GitDiffTab`; `:205-280` implementa **preview tab**
  (single-click transitório, pin ao persistente).
- UI: sidebar, tamanho e tema via `tauri-plugin-store`/Zustand; não há banco.
- Terminal: o modelo Ghostty guarda scrollback por leaf com budget de 192 MiB
  (documentado em `TERAX.md:32-40`; implementação em
  `src/modules/terminal/ghostty/core/scrollbackBudget.ts`).

## 7. Configuração e extensibilidade

- `tauri.conf.json`: janela, CSP, `assetProtocol`, bundle, licenças
  (`src-tauri/tauri.conf.json:1-80`).
- Capabilities: `default.json` (janelas main/settings, `core:default`,
  `opener`, `log`, `os`, `notification`, `store`, `autostart`), `desktop.json`
  (autostart, window-state, updater, process), `clipboard.json`
  (`src-tauri/capabilities/`).
- Settings do app: `src/modules/settings` (tema, fonte, renderer, atalhos,
  modelos/provedores, privacidade).
- Agentes: `src/modules/ai/config.ts` (provedores, modelos, endpoints,
  compat), `src/modules/ai/agents/registry.ts` (perfis), `TERAX.md` (memória).
- Skills/slash commands: `src/modules/ai/lib/slashCommands.ts`,
  `src/modules/terminal/block` (completion, history, inline suggest).
- LSP: presets em `src/modules/lsp/lib/presets.ts:20-50` (TypeScript, Rust,
  Python, Go etc.), com `command`/`args` e instalação sugerida.
- Não há MCP neste repo (não encontrado); o agente usa ferramentas nativas e
  subagentes.

## 8. Permissões, sandbox e erros

| Controle | Evidência | Comentário |
|---|---|---|
| PTY só para a própria origem | `pty/protocol.rs:1-16`; `pty/gate.rs:28-98` | Origin exata, token de stream, body limitado |
| Token por webview | `pty/gate.rs:28-42` | publicado no `pty_stream_open`, revogado no reload |
| Path canônico + recheck | `src/modules/ai/lib/security.ts:265-322` | symlink/TOCTOU: canonicaliza e usa o caminho resolvido |
| Lista de segredos | `security.ts:31-99` | `.env`, chaves, `.ssh`, `.git`, system dirs |
| Comando: C0 + bidi + rm/dd/mkfs/fork bomb/pipe-to-shell | `security.ts:324-402` | bloqueia Trojan Source e pipe-to-shell |
| Escrita só no workspace | `src-tauri/src/modules/fs/mutate.rs:55-82` | `canonicalize` do root e do parent |
| CSP | `tauri.conf.json:29` | `script-src 'self' 'wasm-unsafe-eval'`; `frame-src` amplo |
| AI stream com crédito | `net/stream.rs:16-55` | janela 128 KiB, 256 pacotes, idle 120 s |
| SSRF guard | `net/ip.rs:1-110`; `net/clients.rs:135-209` | classifica IPv4/IPv6, pina DNS, valida cada redirect |

O ponto fraco declarado pelo próprio projeto: `assetProtocol.scope: ["**"]`
(`tauri.conf.json:30-32`) permite asset:// para qualquer caminho; o CSP amplo de
`frame-src` também merece revisão. O path guard do lado JS é forte, mas o lado
Rust confia no `WorkspaceRegistry`; ambos precisam concordar.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Vitest | `src/**/*.test.ts(x)` (222 arquivos) | PTY hub, gate, tabs, explorer, AI tools, LSP, preview |
| Rust | `src-tauri/src/**/*.rs` (149 `#[test]`) | PTY, fs, git, net, lsp, control, sessions |
| Bench | `src/modules/terminal/ghostty/AdaptedGhostty.bench.ts` | renderer Ghostty |
| Soak | `scripts/ghostty-soak.config.ts` | estresse do terminal |
| Perf de renderer | `scripts/renderer-profile/run.py` | workloads idle/move/agents/occlusion |
| IPC | `scripts/ipc-profile/run.py` | custo de IPC no macOS |

É o clone com a suíte mais próxima do nosso produto: 222 arquivos de teste no
frontend e testes Rust para as bordas de PTY/FS/net. A qualidade é alta, mas o
custo de manter Ghostty WASM/WebGPU é alto.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Flow control de PTY com ACK cumulativo + classes de apresentação | `pty/output.rs:11-73`; `pty/presentation.rs:13-75`; `pty/hub.rs:32-45` | nosso terminal faz flush a cada 12 ms sem crédito; um `cat` grande inunda o IPC | Apache-2.0 | `src/main/terminal/flow.ts` | 24 |
| SSRF guard com DNS pinado e classificação de IPv4/IPv6 | `net/ip.rs:1-110`; `net/clients.rs:135-209` | nosso `fetch_url` só bloqueia 3 hosts de metadados e segue redirect cego | Apache-2.0 | `src/core/net/guard.ts` | 23 |
| Shell integration OSC 7/133 + agent detection OSC 777 | `pty/shell_init.rs:9-20`; `pty/agent_detect.rs:17-21`; `scripts/profile.ps1:1-50` | dá cwd, blocos de comando e status de agente sem parsear texto | Apache-2.0 | `src/main/terminal/integration.ts` | 22 |
| Path guard canônico + read-before-edit | `src/modules/ai/lib/security.ts:265-322`; `ai/tools/edit.ts:123-133` | nosso guard resolve o ancestral mas devolve o path lexical; falta o “leu antes de editar” | Apache-2.0 | `src/core/security/path.ts` | 22 |
| Hardening de comando (C0, bidi, pipe-to-shell) | `security.ts:324-402` | nosso `checkCommand` é regex no comando inteiro, sem bidi/CRLF | Apache-2.0 | `src/core/security/shell-policy.ts` | 21 |
| Diff de IA com CodeMirror merge | `src/modules/editor/AiDiffPane.tsx:1-40` | nosso `DiffView` é line-based e sem “aceitar bloco” | Apache-2.0 | `src/renderer/src/components/ChangesPane.tsx` | 21 |
| LSP supervisor com cap de frame, timeout, grupo de processo e RSS | `lsp/framing.rs:1-70`; `lsp/session.rs:69-150` | nosso `code-intelligence` é heurística; falta LSP real | Apache-2.0 | `src/core/lsp/session.ts` | 20 |
| Save atômico com fsync + dir sync + `.bak` + quarentena | `ai_sessions.rs:1-16`, `:218-265` | nosso `store.ts` só faz tmp+rename, sem fsync nem backup | Apache-2.0 | `src/core/session/store.ts` | 19 |
| Explorer com watch/supersede e preview tab | `fs/supersede.rs:15-39`; `tabs/lib/useTabs.ts:205-280` | evita resultado de busca antigo e reduz abas abertas | Apache-2.0 | `src/renderer/src/components/FilesPane.tsx` | 18 |
| Preview só loopback | `src/modules/preview/lib/previewUrl.ts:1-23` | nosso preview aceita `http(s)` arbitrário no webview | Apache-2.0 | `src/main/preview.ts` | 15 |
| Control socket com token | `control.rs:21-32`, `:320`; `src-tauri/crates/terax-control-protocol/src/lib.rs:4-20` | automação externa/testes sem IPC | Apache-2.0 | `src/main/control.ts` | 14 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| Ghostty VT em WASM/WebGPU | 100+ arquivos, shaders, atlas; já temos xterm e não precisamos de outro engine |
| Tauri/Rust backend | nosso backend é Electron/Node; portar seria reescrever o app |
| `terax-cli`/control socket | não temos CLI de app; o custo de superfície não se paga agora |
| Vercel AI SDK como dependência | nosso runner é próprio e multi-provider; trocar agora seria regressão |
| 90 mil linhas de TS do frontend | arquitetura de abas/spaces é útil como ideia, não como código |
| `assetProtocol.scope: ["**"]` | amplo demais; não copiar a configuração |
| `frame-src` permissivo | nosso preview deve ser loopback-only |
| Benchmarks de Ghostty | medem um engine que não vamos usar |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto para o nosso terminal/editor:

1. **Transporte de PTY v2** (`src/main/terminal/flow.ts`):
   `windowBytes = 1 MiB`, `maxChunks = 128`, ACK cumulativo por offset; o renderer
   confirma depois de `term.write`; classes `focused` (4 ms), `visible` (16 ms),
   `hidden` (100 ms), `occluded` (250 ms), com `immediate` para fila > 256 KiB.
   O `TerminalManager` atual (`src/main/terminal.ts:9-12`, `:110-116`) para de
   usar `setTimeout(12)` e passa a drenar por crédito.
2. **Shell integration** (`src/main/terminal/integration.ts`): injetar scripts
   para PowerShell/bash/zsh/fish que emitem OSC 7 (cwd) e OSC 133 A/B/C/D
   (prompt, comando, saída). O parser do xterm registra `registerOscHandler(133,
   ...)` e o main recebe eventos `prompt`, `command`, `cwd`.
3. **Guard de rede** (`src/core/net/guard.ts`): resolver DNS uma vez, classificar
   cada IP (público/privado/loopback/metadata, incluindo IPv4 mapeado em IPv6),
   pinar o IP no `fetch`/`undici` Agent, revalidar cada redirect e limitar a 10.
4. **Path guard** (`src/core/security/path.ts`): `realpath` do alvo ou do parent
   mais próximo, containment sobre o path resolvido, retorno do canônico para usar
   na operação; cache negativo por sessão.
5. **Diff de IA** (`ChangesPane.tsx`): `MergeView` com `unifiedMergeView` e
   `presentableDiff`; o estado `pending/approved/rejected` fica na aba, e o
   “aceitar” aplica um `ChangeSet` no documento original.
6. **LSP** (`src/core/lsp/session.ts`): `Content-Length` com cap de 64 MiB,
   timeout por request, `shutdown`/`exit`, kill de árvore no Windows
   (`taskkill /T`), limite de RSS e reinício com backoff.
7. **Sessão** (`src/core/session/store.ts`): `write tmp → fsync(file) → rename →
   fsync(dir)`, `.bak` da versão anterior, quarentena de JSON inválido.
8. **Teste**: 5 MB de output em 1 terminal oculto vs. focado; 20 redirects para
   `127.0.0.1`; symlink para `.ssh`; comando com `\u202E`; crash/restart no meio
   de um save.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/desktop-ui/crynta--terax-ai rev-parse HEAD
bf7e03df0922dd6a707b916471c3eeedd962a373

$ sed -n '11,23p' src-tauri/src/modules/pty/output.rs
MAX_IN_FLIGHT_BYTES = 1024*1024; MAX_BUFFERED_BYTES = 2*1024*1024; MAX_IN_FLIGHT_CHUNKS = 128

$ sed -n '13,75p' src-tauri/src/modules/pty/presentation.rs
INTERACTIVE_COALESCE=4ms; SUSTAINED=16ms; VISIBLE=16ms; HIDDEN=100ms; OCCLUDED=250ms; IMMEDIATE_BYTES=256KiB

$ sed -n '135,209p' src-tauri/src/modules/net/clients.rs
redirect_decision(...) // scheme, userinfo, host, pinned IP, private/metadata

$ sed -n '324,402p' src/modules/ai/lib/security.ts
checkShellCommand(cmd) // C0, bidi, rm -rf /, ~, --no-preserve-root, dd, mkfs, fork bomb, curl|sh

$ sed -n '265,322p' src/modules/ai/lib/security.ts
checkReadableCanonical/checkWritableCanonical // canonicalize then recheck

$ sed -n '363,459p' src/modules/ai/lib/agent.ts
streamText({ model, system, messages, tools, stopWhen: stepCountIs(MAX_AGENT_STEPS), abortSignal })

$ sed -n '1,40p' src/modules/editor/AiDiffPane.tsx
import { presentableDiff, unifiedMergeView } from "@codemirror/merge"

$ sed -n '1,16p' src-tauri/src/modules/ai_sessions.rs
"one atomically replaced file per session" / fsync / rename / .bak

$ grep -n "MAX_CONTENT_LEN" src-tauri/src/modules/lsp/framing.rs
6: const MAX_CONTENT_LEN: usize = 64 * 1024 * 1024;
```

Limitações: não rodei `pnpm test` nem `cargo test`. O clone é Apache-2.0, mas o
bundle inclui MIT (Ghostty/restty/xterm-js WebGL); os avisos estão em
`src-tauri/tauri.conf.json:44-50`.
