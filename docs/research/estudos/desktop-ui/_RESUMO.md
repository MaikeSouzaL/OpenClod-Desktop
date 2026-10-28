# Estudos desktop-ui — resumo e prioridades

> Sete clones analisados estaticamente em `repositorios/_research/desktop-ui/`.
> Método: leitura de código, sem instalar dependências e sem rodar build/testes
> dos clones. Cada estudo individual tem 13 seções e cita caminho+linha.
> Data da análise: 2026-10-26.

## Veredito por repositório

| Repositório | O que é de fato | Valor para o Openclod | Risco |
|---|---|---|---|
| `electron--electron` | runtime Chromium+Node, não app | fonte das regras de IPC, sandbox, fuses e protocolo | fork C++ inviável; usar como especificação |
| `tauri-apps--tauri` | framework Rust + webview do SO | modelo declarativo de capabilities e canal com backpressure | stack Rust; ACL não se transpõe inteiro |
| `xtermjs--xterm.js` | emulador de terminal 6.0.0 | addons de render/search/serialize que já podemos usar | sem risco de licença; só validar versão |
| `microsoft--monaco-editor` | shell de features + LSP; core é dependência npm | ponte LSP tipada e registro de features | núcleo ausente no clone; bundle grande |
| `codemirror--dev` | meta-repo de desenvolvimento (16 arquivos) | mapa de pacotes; `merge` e `lsp-client` | não contém código dos pacotes |
| `zed-industries--zed` | editor nativo Rust/GPUI com agente | ideias de edição, permissão e sandbox | **207 crates GPL**; não copiar |
| `crynta--terax-ai` | ADE terminal-first Tauri 2 + React 19 | PTY com crédito, SSRF guard, shell integration, diff | Ghostty WASM/WebGPU é pesado |

## Correção de premissa: o nosso terminal já tem PTY

A tarefa descrevia o terminal atual como “log, sem PTY”. O código mostra outra
coisa:

- `src/main/terminal.ts:3` importa `@lydell/node-pty`; `:90-96` faz
  `spawnPty` com `cols/rows/cwd/env`.
- `src/renderer/src/components/TerminalPane.tsx:2-4` usa `@xterm/xterm` +
  `@xterm/addon-fit`; `:76-77` liga `onData`/`onResize` ao PTY.
- `package.json` declara `@lydell/node-pty`, `@xterm/xterm` e `@xterm/addon-fit`.

O que falta não é PTY: é **flow control**, **shell integration**, **busca**,
**renderer GPU**, **snapshot serializado** e **links seguros**. Os candidatos
abaixo refletem isso.

## 15 candidatos priorizados

Score 0–25 = encaixe no produto (0–10) + qualidade/testes (0–5) + robustez de
segurança/bordas (0–5) + portabilidade/licença (0–5).

| # | Candidato | Origem (arquivo:linha) | Score | Tipo | Destino proposto |
|---|---|---|---:|---|---|
| 1 | Flow control de PTY com ACK cumulativo e classes de apresentação | `crynta--terax-ai/src-tauri/src/modules/pty/output.rs:11-73`; `presentation.rs:13-75` | 24 | reimplementação | `src/main/terminal/flow.ts` |
| 2 | Renderer WebGL com fallback para DOM | `xtermjs--xterm.js/addons/addon-webgl/src/WebglAddon.ts:51-84` | 23 | dependência | `src/renderer/src/components/terminal/webgl.ts` |
| 3 | SSRF guard: DNS pinado, classificação IPv4/IPv6 e redirect | `crynta--terax-ai/src-tauri/src/modules/net/ip.rs:1-110`; `net/clients.rs:135-209` | 23 | reimplementação | `src/core/net/guard.ts` |
| 4 | Shell integration OSC 7/133 + agent detection OSC 777 | `crynta--terax-ai/src-tauri/src/modules/pty/shell_init.rs:9-20`; `agent_detect.rs:17-21` | 22 | porta | `src/main/terminal/integration.ts` |
| 5 | Path guard canônico com recheck e uso do realpath | `crynta--terax-ai/src/modules/ai/lib/security.ts:265-322` | 22 | porta | `src/core/security/path.ts` |
| 6 | Validação de IPC por frame/origem, não só webContents.id | `electron--electron/docs/tutorial/security.md:743-778`; `electron_api_ipc_dispatch.cc:661-692` | 22 | prática | `src/main/security/ipc.ts` |
| 7 | Diff/merge com CodeMirror (`MergeView`/`unifiedMergeView`) | `codemirror--dev/bin/packages.js:13`; `crynta--terax-ai/src/modules/editor/AiDiffPane.tsx:1-40` | 22 | dependência | `src/renderer/src/components/ChangesPane.tsx` |
| 8 | Hardening de comando: C0, bidi, pipe-to-shell, rm/dd/mkfs | `crynta--terax-ai/src/modules/ai/lib/security.ts:324-402` | 21 | porta | `src/core/security/shell-policy.ts` |
| 9 | Busca no terminal com decorações e contador | `xtermjs--xterm.js/addons/addon-search/src/SearchAddon.ts:33-167` | 21 | dependência | `src/renderer/src/components/terminal/search.ts` |
| 10 | Sessão de edição com match exato + fuzzy e diff de revisão | `zed-industries--zed/crates/agent/src/tools/edit_file_tool.rs:107-230`; `streaming_fuzzy_matcher.rs:4-9` | 21 | reimplementação (ideia GPL) | `src/core/edit/session.ts` |
| 11 | Supervisor LSP com cap de frame, timeout e kill de árvore | `crynta--terax-ai/src-tauri/src/modules/lsp/framing.rs:1-70`; `session.rs:69-150` | 20 | reimplementação | `src/core/lsp/session.ts` |
| 12 | Snapshot serializado do terminal (não bytes brutos) | `xtermjs--xterm.js/addons/addon-serialize/src/SerializeAddon.ts:1-90` | 20 | dependência | `src/main/terminal.ts` |
| 13 | Fuses de produção + integridade do asar | `electron--electron/docs/tutorial/fuses.md:78-123` | 20 | configuração | `electron-builder.yml` + `scripts/after-pack.cjs` |
| 14 | Deny hardcoded + parse de subcomandos de shell | `zed-industries--zed/crates/agent/src/tool_permissions.rs:10-129`, `:208-313` | 20 | reimplementação (ideia GPL) | `src/core/security/shell-policy.ts` |
| 15 | Save atômico com fsync, dir sync, `.bak` e quarentena | `crynta--terax-ai/src-tauri/src/modules/ai_sessions.rs:1-16`, `:218-265` | 19 | porta | `src/core/session/store.ts` |

### Quase lá (18–19)

| Candidato | Origem | Score | Por que ficou fora do top 15 |
|---|---|---:|---|
| Permissão com escopo de symlink | `zed-industries--zed/crates/agent/src/thread.rs:933-955` | 19 | complementa o path guard; implementar junto |
| Manifesto de capabilities por janela/origem | `tauri-apps--tauri/crates/tauri-utils/src/acl/capability.rs:110-205` | 19 | útil quando houver preview remoto; hoje a superfície é local |
| Canal tipado com fetch sob demanda | `tauri-apps--tauri/crates/tauri/src/ipc/channel.rs:351-458` | 19 | o flow control do PTY resolve o caso mais urgente |
| Ponte LSP tipada (sync de modelo/capabilities) | `microsoft--monaco-editor/monaco-lsp-client/src/adapters/TextDocumentSynchronizer.ts:7-170` | 19 | usar `@codemirror/lsp-client` é mais barato |
| Explorer com watch/supersede e preview tab | `crynta--terax-ai/src-tauri/src/modules/fs/supersede.rs:15-39`; `tabs/lib/useTabs.ts:205-280` | 18 | polish; não bloqueia o núcleo |
| Links OSC 8 com handler seguro | `xtermjs--xterm.js/src/browser/OscLinkProvider.ts:12-60` | 18 | depende de um `openExternal` com allow-list |
| Política de sandbox por thread | `zed-industries--zed/crates/agent/src/sandboxing.rs:1-100` | 18 | no Windows é WSL/Bubblewrap; exigiria decisão de produto |
| Escopo de origem remota no preview | `tauri-apps--tauri/crates/tauri-utils/src/acl/capability.rs:237-248` | 18 | o preview atual já tem partição; falta ACL de comandos |

### Não priorizados (mas estudados)

| Item | Score | Por que ficou fora |
|---|---:|---|
| `sum_tree` para virtualização de transcript | 14 | Apache, mas porte TS trabalhoso; nossa lista é pequena |
| `utilityProcess` para STT/OCR | 15 | melhoria de isolamento, não de UI |
| Restauração de layout que ignora terminal rodando | 15 | nosso app não restaura layout de painéis |
| Preview loopback-only | 15 | o preview atual aceita http(s) arbitrário; corrigir é barato |
| Control socket com token | 14 | automação externa ainda não é requisito |
| SQLite com WAL/migrações | 13 | nosso store JSON atende; migrar é projeto à parte |
| Efeitos de janela Mica/Acrylic | 13 | acabamento; baixa prioridade |
| `freeze_prototype` | 14 | hardening barato, mas pouco impacto no nosso modelo |
| GPUI | 7 | Apache, porém Rust e incompatível com React |
| Sample Electron do Monaco | 3 | inseguro (`file://`, sem sandbox); serve de contraexemplo |

## Lacunas reais da nossa UI (com evidência)

1. **IPC valida só o `webContents.id`**, não a origem do frame
   (`src/main/index.ts:428-449`). Um iframe no main frame tem o mesmo `sender.id`.
2. **Produção usa `file://`** (`src/main/index.ts:581`), o que dá a uma XSS poder
   de leitura de arquivos; falta um protocolo `app://` escopado.
3. **CSP com `script-src 'unsafe-inline'`** (`src/renderer/index.html:5-7`).
4. **Permissões amplas no main**: clipboard/fullscreen são liberados para qualquer
   `contents` (`src/main/index.ts:1635-1648`); só áudio é restrito ao main.
5. **Sem fuses/asar integrity** no `electron-builder.yml`; `asar: true` sozinho
   não valida o conteúdo.
6. **Terminal sem flow control**: flush fixo de 12 ms e 200 mil caracteres, sem
   ACK (`src/main/terminal.ts:9-12`, `:110-116`). Um `cat` de 100 MB inunda o IPC.
7. **Sem shell integration**: não há OSC 7/133 em `src/main/terminal.ts`; cwd e
   limites de comando não são conhecidos.
8. **Sem LSP**: `src/core/code-intelligence/index.ts:1-30` é heurística estática
   (linguagens, símbolos por regex); não há hover/definição/rename.
9. **Diff só por linha**: `ChangesPane.tsx:65-116` parseia `@@` e classifica
   linhas; não há word-level nem merge view.
10. **Path guard devolve o path lexical**: `src/core/security/policy.ts:71-89`
    resolve o ancestral real, mas retorna `absolute`; há janela de TOCTOU.
11. **Store sem fsync/backup**: `src/core/session/store.ts:15-17` faz tmp+rename,
    mas não fsync do arquivo/diretório nem `.bak`.
12. **Preview aceita http(s) arbitrário**: `src/main/index.ts:539-552` só bloqueia
    navegação do main; o webview do preview carrega a URL inicial.
13. **Explorer sem git status**: `FilesPane.tsx` não tem decoração de status,
    rename/delete/create nem drag-drop; o Terax tem (`FileExplorer.tsx`).

## Licenças e reuso

- **MIT**: Electron, xterm.js, Monaco, CodeMirror (meta-repo e pacotes).
- **Apache-2.0 OR MIT**: Tauri; escolher Apache-2.0 na distribuição.
- **Apache-2.0**: Terax; o bundle inclui MIT (Ghostty, restty, xterm-js WebGL),
  com avisos em `src-tauri/tauri.conf.json:44-50`.
- **GPL-3.0-or-later**: Zed, em 207 crates (editor, terminal, agent, rope, diff,
  project panel). 36 crates são Apache-2.0 (`gpui*`, `sum_tree`, `util`, `path`,
  `collections`, `watch`, `http_client`, `extension_api`, `cloud_*`).
- **Zed — regra prática**: só os crates Apache podem ser portados com aviso de
  copyright. Tudo que é GPL entra como **ideia/comportamento**, com implementação
  independente e sem copiar nomes internos, comentários ou trechos.
- **8 crates do Zed sem campo `license`**: `dev_container`, `grammars`,
  `language_core`, `editor_benchmarks`, `fs_benchmarks`, `worktree_benchmarks`,
  `tabular_data_preview` e `project_benchmarks` (conferir antes de qualquer uso).

## Ordem de implementação sugerida

1. **Segurança barata (1–2 dias)**: frame-origin no `handle()`, `app://` no lugar
   de `file://`, CSP com hash, fuses no `afterPack`, preview loopback-only.
2. **Path guard e shell policy (2–3 dias)**: retornar o canônico e usá-lo;
   parser de subcomandos; bloquear C0/bidi/pipe-to-shell; escopo de symlink.
3. **Rede (2 dias)**: `src/core/net/guard.ts` com DNS pinado, classificação de
   IP e redirect; aplicar em `fetch_url` e no proxy de modelos.
4. **Terminal (3–5 dias)**: flow control com ACK e classes; shell integration
   OSC 7/133; addons WebGL, search, serialize e unicode-graphemes.
5. **Editor (3–5 dias)**: `@codemirror/merge` no `ChangesPane`; LSP no main com
   `@codemirror/lsp-client`; diagnósticos com markers.
6. **Sessão e polish (2–3 dias)**: fsync+`.bak`+quarentena; git status no
   explorer; preview tabs; busca no explorer com supersede.

## Como testar cada candidato

- **PTY flow**: 5 MB de output em terminal oculto vs. focado; medir latência do
  primeiro byte, bytes em voo e memória; matar o renderer no meio e verificar
  que o PTY para de produzir.
- **SSRF**: redirect 302 para `127.0.0.1`, `169.254.169.254`, `[::ffff:127.0.0.1]`
  e host que re-resolve para IP privado; todos devem ser bloqueados.
- **Path guard**: symlink `proj/link -> ~/.ssh`, hardlink, junction do Windows,
  path com `..` e drive relativo; todos devem resolver fora e negar.
- **Shell policy**: `cargo build && rm -rf /`, `echo $HOME`, `curl x | sh`,
  comando com `\u202E`, CRLF e `--no-preserve-root`.
- **Diff**: patch com renomeação, CRLF, fim de arquivo sem newline e bloco
  grande; aceitar/rejeitar e verificar o arquivo final.
- **LSP**: `typescript-language-server` com erro de tipo, rename e definição;
  matar o servidor e verificar reinício/erro claro.
- **Sessão**: matar o processo durante o save; reabrir e verificar `.bak` e
  quarentena.

## Arquivos produzidos

- `docs/research/estudos/desktop-ui/electron--electron.md`
- `docs/research/estudos/desktop-ui/tauri-apps--tauri.md`
- `docs/research/estudos/desktop-ui/xtermjs--xterm.js.md`
- `docs/research/estudos/desktop-ui/microsoft--monaco-editor.md`
- `docs/research/estudos/desktop-ui/codemirror--dev.md`
- `docs/research/estudos/desktop-ui/zed-industries--zed.md`
- `docs/research/estudos/desktop-ui/crynta--terax-ai.md`
- `docs/research/estudos/desktop-ui/_RESUMO.md`
