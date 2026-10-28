# Tauri

| Campo | Valor |
|---|---|
| Repositório | https://github.com/tauri-apps/tauri |
| Clone local | `repositorios/_research/desktop-ui/tauri-apps--tauri` |
| Commit | `1fc6d9c85c7d9c79f44afc408853e4b5d3ac1e42` |
| Licença | Apache-2.0 OR MIT (`LICENSE.spdx:1-12`; `LICENSE-APACHE-2.0`; `LICENSE-MIT`) |
| Categoria | desktop-ui (framework desktop) |
| Stack | Rust 2024, wry/tao, serde, tokio; CLI em Rust; API TS em `packages/api`; pnpm (`package.json:1-30`) |
| Tamanho | 1.105 arquivos; ~141 mil linhas (`.rs` ~97,5 mil, `.md` ~17 mil) |

## 1. O que é (verificado no código)

Tauri é um **framework** para construir apps desktop com uma webview do sistema e
um backend Rust. Não é um app: o crate `tauri` (versão `2.12.5`,
`crates/tauri/Cargo.toml:1-6`) fornece `Builder`, janelas, webviews, IPC, menus,
tray, state e o sistema de permissões. O runtime de janela é o `wry`/`tao`
(`crates/tauri/src/lib.rs:10-20`); o app final é compilado pelo usuário.

O entrypoint de um app Tauri é `tauri::Builder::default().run(tauri::generate_context!())`:
`App::run` em `crates/tauri/src/app.rs:1384` e `Builder::run` (que recebe `Context`)
em `:2616`. O `generate_context!` embute o `tauri.conf.json`, os assets e os
scripts de inicialização em tempo de compilação (`ARCHITECTURE.md:22-35`).

A diferença central para o Electron: **não há Node.js no renderer**. A ponte é um
protocolo HTTP-like (`tauri://localhost` ou `http://tauri.localhost`) com uma
`invoke key` de 128 bits gerada por execução (`crates/tauri/src/lib.rs:1278-1285`)
e um ACL declarativo por janela/webview/origem. O README do projeto descreve isso
como "tiny, secure apps" (`crates/tauri/Cargo.toml:4`), e o código confirma a
parte de segurança no IPC, não no tamanho.

## 2. Como executar e comandos reais

| Comando / script | Onde está | O que faz |
|---|---|---|
| `cargo tauri dev` | `crates/tauri-cli/src/lib.rs:147` | sobe o dev server e o app com hot reload |
| `cargo tauri build` | `crates/tauri-cli/src/lib.rs:148` | compila o binário de release |
| `cargo tauri bundle` | `crates/tauri-cli/src/lib.rs:149` | empacota instaladores (NSIS/MSI/dmg/AppImage/deb/rpm) |
| `cargo tauri android` | `crates/tauri-cli/src/lib.rs:150` | build/run Android |
| `cargo tauri ios` | `crates/tauri-cli/src/lib.rs:152` | build/run iOS |
| `cargo tauri icon` | `crates/tauri-cli/src/lib.rs:159` | gera ícones a partir de um PNG |
| `cargo tauri signer` | `crates/tauri-cli/src/lib.rs:160` | assina artefatos/updater |
| `cargo tauri inspect` | `crates/tauri-cli/src/lib.rs:164` | inspeciona config/ACL gerados |
| `cargo tauri migrate` | `crates/tauri-cli/src/lib.rs:154` | migra v1 → v2 |
| `pnpm build` | `package.json:18` | build do workspace (API TS + crates) |
| `pnpm test` | `package.json:24` | testes de todos os pacotes |

A superfície de UX é de **biblioteca + CLI de build**. O app do usuário define
comandos com `#[tauri::command]` e os registra em `invoke_handler` (o Terax faz
isso em `crynta--terax-ai/src-tauri/src/lib.rs:273-300`). Não há atalhos ou slash commands no
núcleo; menus/tray são API (`crates/tauri/src/manager/menu.rs`,
`manager/tray.rs`).

## 3. Arquitetura e fluxo

```text
window/webview (WKWebView/WebView2/WebKitGTK)
  → POST tauri://localhost (ou http://tauri.localhost)
  → parse_invoke_request + invoke_key (128-bit, main frame only)
  → Webview::on_message
  → RuntimeAuthority.resolve_access(cmd, window, webview, origin)
  → comando do app | comando de plugin | erro ACL
  → resposta JSON/binária (200; 405/500 para falhas de protocolo)
```

- Entry point: `App::run` em `crates/tauri/src/app.rs:1384`; `Builder::run` em
  `crates/tauri/src/app.rs:2616`.
- Protocolo IPC: `crates/tauri/src/ipc/protocol.rs:38-117` (handler do scheme,
  CORS, `Tauri-Invoke-Key` em `:24-30`).
- Validação da chave: `Webview::on_message` compara a chave recebida com a
  esperada e retorna sem executar se divergir (`crates/tauri/src/webview/mod.rs:2004-2025`).
- ACL: `RuntimeAuthority::resolve_access` monta a mensagem de erro com janela,
  webview e URL (`crates/tauri/src/ipc/authority.rs:327-363`); a resolução por
  origem está em `:340-351`.
- Execução: `RunInvokeHandler`/`InvokeResolver` despacha para o comando do app ou
  plugin (`crates/tauri/src/webview/mod.rs:2027-2066`).
- Streaming: `Channel<T>` faz `send` de valores serializados e o frontend busca
  cada lote por `plugin:__TAURI_CHANNEL__|fetch`
  (`crates/tauri/src/ipc/channel.rs:31`, `:351-458`).
- Persistência: `StateManager` mantém estado em memória por app
  (`crates/tauri/src/state.rs:104-130`); persistência é do plugin/usuário.

## 4. Catálogo de ferramentas / capacidades

| Ferramenta / capacidade | Arquivo:linha | O que faz | Risco |
|---|---|---|---|
| Comando `#[tauri::command]` | `crates/tauri/src/ipc/command.rs:22-70` | argumento/handler de comando exposto ao JS | alto se não tiver ACL |
| `Channel<T>` | `crates/tauri/src/ipc/channel.rs:351-458` | stream tipado backend→frontend | médio |
| `RuntimeAuthority` | `crates/tauri/src/ipc/authority.rs:28-36` | allow/deny por comando/origem | alto (núcleo de segurança) |
| `Capability` | `crates/tauri-utils/src/acl/capability.rs:110-205` | agrupa permissões por janela/webview/plataforma | alto |
| `CapabilityRemote.urls` | `crates/tauri-utils/src/acl/capability.rs:237-248` | permite origem remota por URLPattern | crítico |
| `WebviewBuilder` | `crates/tauri/src/webview/mod.rs:889-1225` | transparência, proxy, devtools, zoom, background throttling | médio |
| `WebviewWindowBuilder` | `crates/tauri/src/webview/mod.rs:1033-1205` | janela + webview em um objeto | médio |
| `Window::set_effects` | `crates/tauri/src/window/mod.rs:2173` | Mica/Acrylic/Vibrancy | baixo |
| `Pattern::Isolation` | `crates/tauri/src/pattern.rs:13-35` | iframe isolado com AES-GCM | alto (complexidade) |
| `StateManager` | `crates/tauri/src/state.rs:104-130` | estado compartilhado por commands | médio |
| Menus/tray | `crates/tauri/src/manager/menu.rs`, `manager/tray.rs` | menu nativo e bandeja | baixo |
| CSP injection | `crates/tauri-utils/src/html.rs:147-182` | nonce/hash no HTML de produção | médio |

O núcleo **não inclui** updater nem filesystem/shell/dialog: esses são plugins
externos (`crates/tauri-plugin` é só a infraestrutura de plugins). O `tauri.conf.json`
do Terax usa `tauri-plugin-opener`, `clipboard-manager`, `store`, `process`,
`log`, `os` e `updater` como dependências separadas (`crynta--terax-ai/src-tauri/Cargo.toml:47-70`).

## 5. Loop do agente, contexto e streaming

Não há loop de agente. O que existe é um **ciclo de invocação** com três decisões
antes de executar:

1. **É a chave certa?** A `invoke key` é gerada por execução, 128 bits em Z85, e
   injetada apenas no main frame (`crates/tauri/src/lib.rs:1278-1285`;
   `manager/webview.rs:161-202`). Subframes não a recebem.
2. **A origem pode?** `Origin::Local` ou `Origin::Remote { url }` é resolvido a
   partir da URL atual da webview (`webview/mod.rs:2044-2059`); o ACL compara
   janela, webview e contexto (`authority.rs:340-363`).
3. **Qual handler?** O comando do app tem precedência; se não existir, procura o
   plugin pelo prefixo `plugin:<nome>|<comando>` (`webview/mod.rs:2068-2090`).

Streaming: `Channel` não é um socket; cada `send` serializa um valor e o frontend
faz `invoke` do comando interno `fetch` com o id do canal
(`ipc/channel.rs:319-345`, `:441-458`). Isso dá **backpressure natural** (o
frontend busca quando pode), mas adiciona uma ida e volta por lote. Não há
cancelamento nativo de comando em execução; o comando precisa aceitar um
`Channel`/`CancellationToken` e cooperar.

Contexto, retry, compactação e cancelamento não existem no framework; são padrão
do app (o Terax implementa isso em `src/modules/ai/lib/agent.ts`). O Tauri só
fornece a fronteira de IPC.

## 6. Sessões, estado e persistência

- `StateManager` guarda valores `Send + Sync + 'static` por tipo; uma vez
  inseridos, não podem ser removidos nem movidos (`crates/tauri/src/state.rs:100-130`).
  É um singleton por processo, não por janela.
- Sessão de webview: cada webview tem seu próprio data store; o builder aceita
  `data_directory`, `incognito` e `proxy_url`
  (`crates/tauri/src/webview/mod.rs:1040-1100`).
- Janela: `window-state` é plugin externo; o núcleo só oferece `set_*` de geometria,
  tema, efeitos e `start_dragging` (`crates/tauri/src/window/mod.rs:1915-2427`).
- Config é **compile-time**: `tauri.conf.json` vira `Context`; não há hot reload de
  permissões. `dynamic-acl` permite adicionar capabilities em runtime
  (`crates/tauri/src/lib.rs:49`; `ipc/capability_builder.rs`).
- Não há store de conversa, checkpoint ou retomada no crate `tauri` (não encontrado). O app decide (o Terax grava
  JSON por sessão em `crynta--terax-ai/src-tauri/src/modules/ai_sessions.rs:1-130`).

## 7. Configuração e extensibilidade

- `tauri.conf.json`: `app.windows`, `app.security.csp`, `app.security.pattern`,
  `bundle`, `plugins` (`crynta--terax-ai/src-tauri/tauri.conf.json:1-80` no Terax).
- `capabilities/*.json`: lista de `windows`, `webviews`, `permissions`,
  `platforms`, `remote.urls` (`crates/tauri-utils/src/acl/capability.rs:110-205`).
- Permissões são arquivos gerados por plugin (TOML/JSON) e compiladas em
  `ResolvedCommand`; o ACL tem `allowed_commands` e `denied_commands`
  (`crates/tauri/src/ipc/authority.rs:28-36`).
- Plugins: `TauriPlugin` com `setup`, `invoke_handler`, `on_page_load`,
  `on_webview_ready` (`crates/tauri/src/plugin.rs:5-16`); plugins de terceiros ficam
  fora deste repositório.
- Isolation: iframe escondido com chave AES-GCM por execução; a mensagem só é
  aceita se vier pelo iframe (`crates/tauri/src/pattern.rs:13-35`;
  `crates/tauri-utils/src/pattern/isolation.rs:43-85`).
- `freeze_prototype`: congela protótipos de `Object`/`Array` para dificultar
  prototype pollution no renderer (`manager/webview.rs:417-448`).
- CSP: o build injeta `<meta http-equiv="Content-Security-Policy">` e nonce em
  scripts/styles (`crates/tauri-utils/src/html.rs:147-182`).

## 8. Permissões, sandbox e erros

| Controle | Evidência | Comentário |
|---|---|---|
| Allow/deny por comando | `authority.rs:327-363` | erro detalhado diz em qual janela/webview/URL o comando é permitido |
| Origem local vs. remota | `webview/mod.rs:2044-2059` | `Origin::Remote` usa a URL atual, não a URL inicial |
| URLPattern para remoto | `capability.rs:241-248` | `https://*.mydomain.dev` e subpaths |
| Chave de invocação | `lib.rs:1278-1285`; `webview/mod.rs:2009-2025` | 128 bits, main frame only |
| Isolation | `pattern.rs:13-35` | iframe + AES-GCM; recomendado para conteúdo não confiável |
| CSP com nonce/hash | `tauri-utils/src/html.rs:147-182` | reduz `unsafe-inline` |
| `freeze_prototype` | `manager/webview.rs:417-448` | hardening barato |
| Erros de ACL | `authority.rs:354-363` | mensagem rica; não vaza para origem remota se o comando não for permitido |
| Escopo de aplicação | `webview/mod.rs:2080-2090` | o ACL só é exigido para plugin, app com manifest ou origem remota; comando local sem manifest passa direto |

O sandbox do SO não é responsabilidade do Tauri: ele usa a webview do sistema e
deixa o sandbox de processos para o app (no macOS, entitlements; no Windows,
AppContainer/job objects). O Tauri **não** tem um `WorkspaceGuard` de filesystem;
isso é do plugin de fs (externo). O erro de ACL é retornado como string ao
renderer pelo `resolver.reject`, dentro de uma resposta 200; o protocolo só usa
405 para método inválido e 500 para parse/falha interna (`ipc/protocol.rs:146-174`).
Não há código de erro estruturado.

## 9. Testes e qualidade

| Suíte | Onde | O que cobre |
|---|---|---|
| Unit tests do core | `crates/tauri/src/**/*.rs` (`#[test]`) | ACL, protocolo, janela, config, scripts |
| Integração de restart | `crates/tauri/tests/restart.rs` | ciclo de vida e relaunch |
| CLI | `crates/tauri-cli/tests/init.rs` | parsing/geração de projetos |
| Exemplos | `examples/` (`multiwebview`, `isolation`, `streaming`, `state`) | uso real das APIs |
| Benchmarks | `bench/` | só `Cargo.toml`/`README`, sem benchmark implementado |

A contagem de `#[test]` no crate `tauri` é ~84 (busca textual; não executei a
suíte). A qualidade é boa para o núcleo de ACL/protocolo, mas o teste de
segurança mais importante — origem remota + capability — é unitário, não E2E com
webview real.

## 10. O que vale portar

| Módulo | Origem (arquivo:linha) | Por que é melhor | Licença | Destino proposto | Score |
|---|---|---|---|---|---|
| Manifesto declarativo de capacidades por janela/origem | `crates/tauri-utils/src/acl/capability.rs:110-205`; `authority.rs:327-363` | hoje nossa permissão é por ferramenta, não por **superfície de UI**; um preview remoto não deveria chamar `terminal.*` | Apache-2.0/MIT | `src/shared/capabilities.ts` + `src/main/security/capabilities.ts` | 19 |
| Canal tipado com fetch sob demanda | `crates/tauri/src/ipc/channel.rs:351-458` | substitui `webContents.send` sem ack por um stream com backpressure | Apache-2.0/MIT | `src/core/ipc/channel.ts` | 19 |
| Escopo de origem remota para webview de preview | `capability.rs:237-248`; `webview/mod.rs:2044-2059` | o preview hoje tem partição, mas não um ACL de comandos | Apache-2.0/MIT | `src/main/preview/capabilities.ts` | 18 |
| Nonce/hash de CSP no build | `crates/tauri-utils/src/html.rs:147-182` | remove `unsafe-inline` do nosso `index.html` | Apache-2.0/MIT | `scripts/build-csp.mjs` | 15 |
| `freeze_prototype` no renderer | `crates/tauri/src/manager/webview.rs:417-448` | hardening barato contra prototype pollution | Apache-2.0/MIT | `src/preload/index.ts` | 14 |
| `Window` + `Webview` separados (multiwebview) | `crates/tauri/src/lib.rs:20-28` | modelo para o preview e o editor compartilharem janela | Apache-2.0/MIT | `src/main/window-factory.ts` | 14 |
| Efeitos de janela (Mica/Acrylic) | `crates/tauri/src/window/mod.rs:2173-2190` | acabamento nativo no Windows | Apache-2.0/MIT | `src/main/window/effects.ts` | 13 |
| Isolation pattern com AES-GCM | `crates/tauri/src/pattern.rs:13-35` | útil só se aceitarmos HTML remoto no main frame | Apache-2.0/MIT | não propor | 11 |

## 11. O que NÃO vale portar

| Item | Motivo |
|---|---|
| `wry`/`tao` e o runtime de janela | stack Rust; nosso runtime é Electron |
| Crates `tauri-runtime*`, `tauri-codegen`, `tauri-macros` | acoplados ao build Rust/macros |
| ACL com `RuntimeAuthority` em Rust | já temos um motor de permissões em TS; portar o **formato** basta |
| Suporte mobile (Android/iOS) | fora do escopo do Openclod desktop |
| Ecossistema de plugins (fs/shell/dialog/updater) | são produtos separados, não este repo |
| Isolation pattern | complexidade alta para um app que não carrega conteúdo remoto no main frame |
| CLI de build | usamos electron-vite/electron-builder |
| Abas/explorer de arquivos | não são do framework (não encontrado); são do app |

## 12. Modelo de exemplo para o nosso harness

Desenho concreto:

1. **`src/shared/capabilities.ts`** exporta um mapa estático:
   `{ surface: 'main' | 'preview' | 'settings', commands: string[], origins: string[] }`.
   Cada namespace do nosso `forja` (`terminal`, `files`, `git`, `browser`,
   `computer`) declara quais superfícies podem chamá-lo. O wrapper
   `handle()` (`src/main/index.ts:435-449`) consulta esse mapa antes do handler.
2. **`src/main/security/origin.ts`**: `originOf(frame)` normaliza
   `event.senderFrame.origin`; `isAllowed(surface, origin)` compara com o mapa.
   Para o preview, a origem é `http://localhost:*`/`https://*` só se a capability
   `preview` permitir; o `partition` sozinho não é autorização.
3. **`src/core/ipc/channel.ts`**: um `Channel<T>` com `id`, `send(value)` e
   `close()`; o renderer puxa lotes via `invoke('channel:fetch', id)`. Usar para
   stdout de ferramentas longas e para o stream do agente, no lugar de
   `webContents.send` sem ack.
4. **`scripts/build-csp.mjs`**: gera o `<meta>` com hash dos scripts inline do
   Vite e remove `'unsafe-inline'`; em dev, mantém o modo permissivo.
5. **`src/preload/index.ts`**: depois de `exposeInMainWorld`, congela os
   protótipos que o renderer não precisa mudar (`Object`, `Array`, `Function`),
   com opt-out para testes.
6. **Teste**: uma matriz `surface × comando` que chama o IPC a partir de um iframe
   `data:` e espera `origem não autorizada`; e um teste de que o preview não
   consegue chamar `terminal.create`.

## 13. Evidências da análise

```text
$ git -C repositorios/_research/desktop-ui/tauri-apps--tauri rev-parse HEAD
1fc6d9c85c7d9c79f44afc408853e4b5d3ac1e42

$ sed -n '1,10p' crates/tauri/Cargo.toml
name = "tauri"
version = "2.12.5"
license.workspace = true

$ sed -n '1384,1390p' crates/tauri/src/app.rs
pub fn run<F: FnMut(&AppHandle<R>, RunEvent) + 'static>(mut self, callback: F)

$ sed -n '2004,2025p' crates/tauri/src/webview/mod.rs
pub fn on_message(self, request: InvokeRequest, responder: Box<OwnedInvokeResponder<R>>) {
  let expected = manager.invoke_key();
  if request.invoke_key != expected { ... return; }

$ sed -n '1278,1285p' crates/tauri/src/lib.rs
pub(crate) fn generate_invoke_key() -> Result<String> {
  let mut bytes = [0u8; 16]; getrandom::fill(&mut bytes)?; Ok(z85::encode(&bytes))
}

$ sed -n '340,363p' crates/tauri/src/ipc/authority.rs
let resolved_matching_origin = resolved.iter().filter(|cmd| origin.matches(&cmd.context))
... "allowed" | "not allowed on window ... URL ..."

$ sed -n '110,205p' crates/tauri-utils/src/acl/capability.rs
pub struct Capability { identifier, description, remote, local, windows, webviews, permissions, platforms }

$ sed -n '147,182p' crates/tauri-utils/src/html.rs
inject_nonce_token(...); inject_csp(document, csp)
```

Limitações: não compilei nem rodei os testes do Tauri. O clone é o workspace
`dev`; a versão do crate `tauri` é `2.12.5`. O updater não está neste repositório.

