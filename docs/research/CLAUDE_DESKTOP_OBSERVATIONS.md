# Claude Desktop — observações com REA

> **Rodada 2 (2026-10-23)** no fim deste arquivo: instalador, pacote MSIX,
> superfície IPC completa (1.400 métodos), protocolo com o harness e processos
> em execução. Ela resolve vários itens que a rodada 1 deixou em aberto
> (ver `UNKNOWN_BEHAVIOR.md`).

## Rodada 1 — método e escopo

| Item | Valor |
|---|---|
| Ferramenta | REA 6.7.0 (`npx rea-agents@6.7.0`), MIT |
| Comando | `rea analyze-javascript-application <app.asar> --format json` |
| Alvo | `C:\Program Files\WindowsApps\Claude_3.6556.1.0_x64__pzs8sxrjxfjjc\app\resources\app.asar` |
| Produto | Claude Desktop 3.6556.1 (MSIX, publisher Anthropic) |
| Tamanho do asar | 52.745.965 bytes |
| SHA-256 | `bf6735ef514a3c87efb1aa5d83cd1c43a9ea35295322622e9d81d8e261becf98` |
| Saída | 455.172.322 bytes (UTF-16, convertido para 227.586.163 bytes UTF-8) |
| `rea doctor` | `healthy: false` — apenas por ausência de Hopper/Ghidra/IDA; análise JS = OK |

Cópia do `app.asar` e da saída foram feitas em diretório temporário, fora do
repositório. Nenhum código-fonte foi copiado para o projeto.

## Fatos estruturais (contagens do grafo normalizado)

Contagens objetivas extraídas do JSON de evidência:

| Métrica | Valor |
|---|---|
| Arquivos JavaScript inventariados | 573 |
| — sob `.vite/` | 523 |
| — sob `node_modules/` | 41 |
| Endpoints (`kind: endpoint`) | 153 |
| Rotas (`kind: route`) | 469 |
| Fronteiras (`kind: boundary`) | 45 |
| Listeners (`kind: listener`) | 87 |
| Eventos (`kind: event`) | 117 |
| Requires | 3.953 |
| Chamadas de rede | 1.044 |
| Workers | 10 |
| Módulos ES | 12 |
| Tarefas | 11 |
| Bindings | 16.707 |
| Funções | 11.999 |
| Expressões | 33.874 |

Interpretação cautelosa:
- **573 arquivos** e **153 endpoints** indicam um app Electron dividido em
  processo principal + renderer(s), com superfície IPC considerável.
- **45 fronteiras** e **87 listeners** são consistentes com múltiplos
  `contextBridge`/`ipcRenderer` (o bundle contém 93 ocorrências textuais de
  `contextBridge` e 534 de `ipcRenderer`).
- **10 workers** sugerem trabalho fora da thread de UI (indexação, parsing,
  streaming).

## Observação em execução (evidence independente do REA)

Processo real capturado via `open-computer-use`:

```
claude.exe  pid=19072
"C:\Program Files\WindowsApps\Claude_3.6556.1.0_x64__pzs8sxrjxfjjc\app\Claude.exe"
janela: "Claude" (id 458908)
```

Árvore de acessibilidade exposta (`ocu snapshot claude`):

```
0 window Claude
  1 pane
  2 região Claude
    3 região
      4 região
        5 região {x:1791,y:8,w:137,h:36}
          6 botão Minimizar
          7 botão Restaurar
          8 botão Fechar
        9..14 região (sem filhos)
The focused UI element is região.
```

**Fato relevante:** a árvore para no nível de "região". Não há `textbox`,
`button` ou `document` do conteúdo. Isso é típico de Electron com a ponte de
acessibilidade desligada/limitada até que um leitor de tela seja detectado.

**Consequência de projeto:** um agente que dependa só de UI Automation falha em
apps Electron como esse. O Openclod implementa percepção híbrida (UIA → screenshot
+ visão → coordenadas), exatamente como o briefing exige. Isso foi validado no
próprio Claude Desktop: só a captura de tela permite "ver" a interface.

## O que o app faz (observável na UI, sem engenharia reversa de código)

- Janela única com chrome customizado (minimizar/restaurar/fechar desenhados).
- Sessões de trabalho com projeto e histórico.
- Painel de conversa com streaming.
- Superfície de ferramentas (o bundle tem 153 endpoints e 469 rotas; a
  distribuição sugere separação entre sessão, arquivos, terminal e MCP).
- Menções textuais no bundle (contagem bruta, apenas indicativa): `terminal`
  277, `mcp` 784, `skill` 87, `permission` 22, `sandbox` 37, `subagent` 6,
  `worktree` 9, `compact` 28, `resume` 22, `hook` 82.

> As contagens textuais acima **não** provam funcionalidade: são frequência de
> substring no bundle inteiro (inclui `node_modules`). Servem para priorizar
> investigação, não como evidência de recurso implementado.

## Limitações desta análise

1. O REA não recupera código-fonte; o grafo expõe estrutura, não texto.
2. Sem Hopper/Ghidra/IDA não há análise do binário nativo (`Claude.exe`), apenas
   do JavaScript.
3. O app é MSIX; a leitura do `app.asar` exigiu copiar o arquivo (feito com
   permissão de Administrador nesta máquina).
4. O `app.asar` do Claude Desktop **não** contém o harness: ele é um cliente.
   O harness do Claude Code roda no CLI (`@anthropic-ai/claude-code`), que é um
   bundle separado e não foi analisado nesta rodada.
5. Nenhuma conclusão aqui autoriza copiar código proprietário.

---

## Rodada 2 — 2026-10-23 (REA via MCP + observação de processos)

Método: servidor MCP do REA (`rea.mjs mcp`) com `open_binary`,
`inspect_pe_resources`, `inspect_artifact`, `extract_artifact` e
`analyze_javascript_application`; leitura dos arquivos extraídos como **dados**
(nada foi executado); `Get-CimInstance Win32_Process` para a árvore de
processos. Evidências brutas (não versionadas): `tmp/rea/rea-evidence-2026-10-23.json`
(SHA-256 `020621f9…f06682`, 7 registros) e `tmp/rea/eipc-surface.md`.
Nenhum código do Claude Desktop foi copiado para o projeto; abaixo há apenas
nomes, contagens e comportamento observado.

### 2.1 O instalador não contém o app

| Item | Valor observado |
|---|---|
| Arquivo | `Downloads\Programs\Claude Setup_7.exe`, 7.199.392 bytes |
| SHA-256 | `982fbd61c96a062838e747422358b119662720d80c975e9ec48f31c1b9ef5644` |
| VersionInfo | `ClaudeSetup.exe`, "Claude Setup", 1.0.0.0, Anthropic, PBC |
| Assinatura | Authenticode **válida**, CN="Anthropic, PBC" |
| Recursos PE (REA) | 17 recursos: 14 ícones (16–256 px), 1 grupo de ícone, 1 VERSIONINFO, 1 manifesto. Nenhum payload. |

Conclusão: é um **bootstrapper** que baixa e instala o pacote MSIX. Layouts e
funcionalidades só podem ser estudados no app instalado, que é o que as seções
seguintes analisam.

Ghidra 12.1.4 (via CLI do REA em `Desktop\REA`, com o ambiente de
`rea-local.json`) analisou o instalador: 6.483 procedimentos, 17.957 strings,
10 segmentos. Snapshot da análise:
`Desktop\REA\temporarios\claude-setup-7.rea-snapshot` (para descompilar funções
específicas depois).

**O que o bootstrapper faz** (tabela de símbolos e strings do binário, lidos
como bytes; nenhuma função foi descompilada ainda):

- Programa **Go 1.25.14**, módulo `github.com/anthropics/win32-bootstrapper`,
  com `github.com/anthropics/win-httpproxy` para proxy. 171 funções `main.*`.
- Fluxo inferido pelos nomes das funções:
  1. Log em `ClaudeSetup.log` (`initLog`, `logSystemInfo`) e
     `HardenDllSearchOrder`.
  2. Diagnóstico do sistema: `detectArch` (x64/arm64), `detectWindowsVersion`,
     `detectSMode`, `detectSideloading`, `detectElevation`, `checkPrereqs`.
  3. Rede: `systemProxyFunc`, `checkForProxyInterception`, `proxyRemediation`
     (a mensagem aponta a lista de hosts em
     `support.claude.com/.../12622667-enterprise-configuration`).
  4. Descoberta da versão: `fetchLatestVersion`/`fetchLatestAsset` em
     `https://api.anthropic.com/api/desktop/win32`,
     `https://releases.claude.com/api/desktop/win32` e
     `https://downloads.claude.ai` (padrão `%s/%s/%s/latest`).
  5. Download com nova tentativa e janela de progresso própria com ajuste de
     DPI (`downloadFile`, `retryHTTP`, `ShowProgressWindow`, `dpiScale`).
  6. Verificação da assinatura do pacote baixado (`verifyInstallerSignature`,
     `WinVerifyTrust`, `getSignerSubject`, `installerSignerTrusted`).
  7. Preparação: fecha o Claude em execução (`killRunningClaude`,
     `killMSIXClaude`), remove serviço conflitante (`CoworkVMService`) e
     pacotes antigos preservando dados quando possível
     (`removeWithPreserveDataFallback`).
  8. Instalação MSIX via WinRT `PackageManager` (`AddPackageAsync`,
     `ProvisionPackageForAllUsersAsync`, `awaitDeploymentOperation`,
     `getDeploymentErrorText`), com reparo de instalação travada
     (`repairWedgedInstall`).
  9. Plano B: instalação **Squirrel** (`installViaSquirrel`,
     `showSquirrelFallbackPrompt`) quando o MSIX não é possível (sideloading
     bloqueado, S Mode etc.).
  10. Abre o app **sem elevação** (`launchDeElevated`).
- Também desinstala: `runUninstall`, `uninstallMSIXPackage(Elevated)`,
  `uninstallSquirrel`.
- A única interface do instalador é a janela de progresso e as caixas de erro;
  ele não contém telas do app.

Ideias aproveitáveis no empacotamento do Openclod (fase 7): verificar assinatura
do que for baixado, fechar a instância em execução antes de atualizar,
preservar `%APPDATA%\Openclod` na desinstalação, detectar proxy com mensagem de
remediação e abrir o app sem elevação depois de instalar.

### 2.2 Pacote instalado (MSIX 3.6556.1.0)

`C:\Program Files\WindowsApps\Claude_3.6556.1.0_x64__pzs8sxrjxfjjc`,
`AppxManifest.xml`:

- Capabilities: `runFullTrust`, `localSystemServices`, `packagedServices`,
  `unvirtualizedResources`, `internetClient`.
- Extensões: protocolo `claude://`; `StartupTask` (desligada por padrão);
  aliases `claude-desktop.exe`, `claude-ssh-askpass.exe`, `claude-ssh-proxy.exe`,
  `claude-make-data-folder.exe`; **serviço Windows `CoworkVMService`**
  (localSystem, auto); regras de firewall de saída para `Claude.exe` e
  `cowork-svc.exe`.

Componentes em `app\resources\` e o papel inferido de cada um:

| Componente | Papel (evidência) |
|---|---|
| `app.asar` (52,7 MB, `@ant/desktop` 3.6556.1) | processo principal Electron + preloads |
| `ion-dist/` (4.458 arquivos) | **cliente web empacotado localmente** (frames `frame-shell`, `frame-connect`, `frame-manage`; 37.201 strings em `i18n/en-US.json`). É a UI que o usuário vê. |
| `cowork-svc.exe` + `smol-bin.x64.vhdx` (37,7 MB) | serviço + imagem de VM do Cowork (roda como serviço do Windows, pai `services.exe`) |
| `chrome-native-host.exe`, `claude-browser-shim.js` | ponte com a extensão "Claude in Chrome" |
| `claude-ssh-{askpass,broker,proxy}.exe` | sessões de código remotas via SSH |
| `app.asar.unpacked/node_modules/node-pty` (ConPTY) | terminal PTY real |
| `app.asar.unpacked/resources/github-mcp/github-mcp-server.exe` | servidor MCP do GitHub embutido |
| `app.asar.unpacked/resources/office365-mcp/*` (MSAL) | MCP do Microsoft 365 |
| `@ant/claude-native` (addon nativo) | integração nativa do SO |
| 35 arquivos `<locale>.json` | i18n do processo principal (872 strings em en-US) |

Impressão digital dos binários nativos (strings lidas como bytes, sem
executar):

| Binário | Linguagem | Marcadores |
|---|---|---|
| `cowork-svc.exe` (13,8 MB) | Go | API HCS do Windows (`HcsCreateComputeSystem`), `vhdx`, `hvsocket`/`vsock` (384 ocorrências), pipes `\\.\pipe\cowork-vm-service`, `\\.\pipe\cowork-vm-console-`, `\\.\pipe\cowork-daemon-console`. O Cowork roda numa **VM utilitária Hyper-V criada via HCS** a partir do `smol-bin.x64.vhdx` e conversa por hvsocket. |
| `chrome-native-host.exe` (1,1 MB) | Rust | menções a `mcp`, named pipe: a extensão do Chrome fala com o app por native messaging + pipe |
| `claude-ssh-broker.exe`, `claude-make-data-folder.exe` | Go | — |

`package.json` do asar: `main = .vite/build/index.pre.js`; dependências
`@ant/claude-for-chrome-mcp`, `@ant/claude-native`, `@ant/claude-swift`,
`@ant/computer-use-mcp`, `@ant/imagine-server`, `@loc/electron-window`,
`https-proxy-agent`, `ws`; opcional `node-pty`.

Integridade (REA `inspect_artifact`): 676 ocorrências, 650 nós. Seis
contradições, **todas em binários nativos desempacotados**
(`claude-native-binding.node`, dois `conpty*.node`, `github-mcp-server.exe`,
dois do office365-mcp). É o padrão de assinar os binários depois de gerar o
asar; extraímos com `record-and-continue` e esses bytes ficam marcados como
não confiáveis.

### 2.3 Janelas, preloads e workers

Entradas nomeadas em `.vite/build/` (além de 467 chunks):

- Janelas/preloads: `mainWindow`, `mainView`, `quickWindow`, `aboutWindow`,
  `findInPage`, `artifactShell`, `coworkArtifact`, `designWindow`,
  `claudePagePreview`, `localExecConsent`, `computerUseTeach`,
  `computerUseWatchRecord`, `watchRecordChooser`, `buddy`.
- Workers/utilitários: `pty-host`, `mcp-runtime`, `file-index-worker`,
  `transcript-search-worker`, `shell-path-worker`, `heavy-work-worker`,
  `frame-local-worker`, `msal-broker-worker`, `stall-sampler-worker`.

APIs expostas por `contextBridge.exposeInMainWorld` (54 chamadas):
`claudeAppBindings`, `claudeAppSettings`, `cowork`, `electronWindowControl`,
`electronIntl`, `desktopBootFeatures`, `desktopManagedConfig`,
`desktopEnterpriseConfig`, `claudeDesktopArtifactPane`, `buddy`, entre outras.

### 2.4 Superfície IPC completa (resolve o desconhecido #1)

Os canais seguem o formato
`$eipc_message$_<uuid>_$_<namespace>_$_<Interface>_$_<método>` e são montados
por concatenação. Por isso a regex da rodada 1 não achava nada. Um parser
estático (resultado em `tmp/rea/eipc-surface.md`) encontrou **1.400 métodos em
19 namespaces**:

| Namespace | Métodos | Namespace | Métodos |
|---|---|---|---|
| `claude.web` | 1.047 | `claude.officeAddin` | 14 |
| `claude.settings` | 144 | `claude.internal.sableOtter` | 11 |
| `claude.simulator` | 71 | `claude.internal.findInPage` | 7 |
| `claude.engineSurface` | 25 | `electron_window` | 7 |
| `claude.internal.computerUse` | 22 | `claude.coworkArtifact` | 6 |
| `claude.buddy` | 18 | `claude.windowVibrancy` | 4 |
| `claude.internal.ui` | 15 | outros 6 | 1–3 cada |

Interfaces de `claude.web` com mais métodos (indicam onde está o produto):

| Interface | Métodos | Interface | Métodos |
|---|---|---|---|
| `LocalSessions` (aba Code) | 352 | `CCDScheduledTasks` | 13 |
| `LocalAgentModeSessions` (Cowork) | 131 | `FramebufferPreview` | 11 |
| `Launch` | 117 | `ClaudeCode` | 11 |
| `CoworkSpaces` | 34 | `AutoUpdater` | 10 |
| `CoworkArtifacts` | 26 | `RemoteControlServing` | 9 |
| `MenuEvents` | 22 | `DesktopNotifications` | 8 |
| `LocalPlugins` | 19 | `ComputerUseTcc` | 7 |
| `FileSystem` | 19 | `ChromeExtension` | 7 |
| `DeviceRegistry` | 19 | `LocalSessionEnvironment` | 6 |
| `CoworkScheduledTasks` | 18 | `SessionPopouts` | 4 |
| `ClaudeVM` | 16 | `GitState`, `CloudMove`, `CliSessionImport` | 2–3 |
| `CustomPlugins` | 15 | `WindowLayout` | 3 |

Grupos de métodos de `LocalSessions` (nomes resumidos, agrupados por nós):

- Ciclo da sessão: `start`, `sendMessage`, `interrupt`, `stop`, `archive`,
  `unarchive`, `delete`, `forkSession`, `clearSession`, `updateSession`,
  `searchSessions`, `getTranscript*`, `shareSession`, fila de mensagens
  (`cancelQueuedMessage`, `promoteQueuedMessage`, `reorderQueuedMessage`).
- Controle do harness: `setModel`, `setEffort`, `setFastMode`,
  `setPermissionMode`, `applyFlagSettings`, `getContextUsage*`,
  `onToolPermissionRequest` / `respondToToolPermission`, `rewind`,
  `rewindFiles`, `undoRewind`, output styles, `getSupportedCommands`.
- Git/GitHub: `getGitDiff*`, `getGitCommits`, `getUncommittedChanges`,
  `stashWorkingTree`, `commitWipForBranchSwitch`, `discardKeptWorktree`, PRs
  (`getPrOverview`, `getPrChecks`, `mergePr`, `markPrReady`, `enableAutoMerge`,
  comentários de revisão, `armAutoFixOnNextPr`), `launchUltrareview`.
- Terminal: `startShellPty`, `writeShellPty`, `resizeShellPty`, `stopShellPty`,
  `runBashCommand`, `interruptBashCommand`.
- MCP por sessão: `mcpCallTool`, `mcpListResources`, `mcpReadResource`,
  `mcpAuthenticate`, `mcpReconnect`, `setMcpServers`, `replaceEnabledMcpTools`.
- Remoto: cerca de 60 métodos `*SSH*`, `listWslDistros`/`canStartWslSession`,
  `teleportToCloud`, `toggleRemoteControl`.
- Side chats: `startSideChat`, `sendSideChatMessage`, `startBtwChild`.
- Tarefas em background: `backgroundTasks`, `getTaskOutput`, `stopTask`,
  `getTaskBacklog`.
- Arquivos da sessão: `readSessionFile`, `writeSessionFile`, `pickFileAtCwd`,
  `listSessionDirectory`, `watchSessionDirectories`, `openInEditor`.
- Confiança de pasta: `checkTrust`, `saveTrust`, `answerPendingCwdTrust`.

`claude.settings` agrupa `AppConfig`, `AppFeatures`, `AppPreferences`, `CcdCli`,
`MCP`, `Extensions`, `GlobalShortcut`, `Startup`, `WakeScheduler`,
`SupportBundle`, `Custom3p*` (provedores de terceiros) e importação de
histórico. `claude.internal.computerUse` tem `CuTeach`, `CuWatchRecordChooser`
e `CuWatchRecordPill` (modo "ensinar"/gravar demonstração).

### 2.5 Como o app conversa com o harness (resolve #2 e #12)

**Estático (bundle):** o asar contém um transporte do Claude Agent SDK
(`claude-agent-sdk` aparece no bundle) que monta o processo com
`--output-format stream-json --verbose --input-format stream-json`, flags de
thinking (`--thinking=adaptive|disabled`, `--max-thinking-tokens`),
`--permission-prompt-tool`, `--include-partial-messages`, `--resume` e
`--mcp-config`. Mensagens de controle observadas por `subtype`:
`initialize`, `set_permission_mode`, `set_model`, `set_max_thinking_tokens`,
`set_cwd`, `permission_response`, `permission_auto_approved`, `stop_task`,
`side_question`, `task_started`, `task_notification`, `update_settings`,
`ultrareview_launch` e uma família `ui_*` (`ui_render`, `ui_press`,
`ui_input`, `ui_panes`…) usada pela `engineSurface`. `CLAUDE_CODE_ENTRYPOINT`
é definido pelo app (valor `local-agent` em um dos caminhos). Worktrees ficam
em `.claude/worktrees/`.

**Em execução (2026-10-23, 15:20):**

```
Claude.exe #19072 (pai: explorer)                      app Electron
 ├─ claude.exe #21080  (CLI 2.1.308, em %LOCALAPPDATA%\Claude-Data\…\claude-code\)
 │     --output-format stream-json --verbose --input-format stream-json
 │     --effort=xhigh --model=claude-opus-5-5 …
 │   ├─ node rea.mjs mcp                                MCPs são filhos do CLI
 │   └─ node bridge_gpt/dist/index.js
 ├─ claude.exe #21656  (outra sessão Code, mesma forma)
 └─ claude.exe #8312   (outra sessão Code, mesma forma)
cowork-svc.exe #5500 (pai: services.exe)                serviço da VM do Cowork
```

Fato: **um processo CLI por sessão ativa da aba Code**. O app é cliente e
gerente de sessões; o harness (loop, ferramentas, MCP) roda no CLI. O ponto 4
das limitações da rodada 1 estava certo e agora está provado em execução.

### 2.6 Superfícies de interface (contagem de strings do `ion-dist`)

Strings de UI em `ion-dist/i18n/en-US.json` que mencionam cada termo. Indica o
tamanho de cada superfície; não prova comportamento.

| Superfície | Strings | Exemplos de rótulo |
|---|---|---|
| Artifacts | 978 | Artifact view, Show artifact |
| Connectors/MCP | 716 | Add connector, MCP connector |
| Rotinas/agendadas | 676 | Routines, run routine |
| Plugins / Marketplace | 609 / 194 | Add plugin, Manage marketplaces |
| Skills | 555 | Add skill, Ran skill |
| SSH | 395 | SSH host, SSH sessions |
| Cowork | 330 | Cowork tasks, Open Cowork |
| Diff | 301 | Diff layout, View in diff |
| Archive | 240 | Archive all, Unarchive |
| Preview | 208 | Preview tabs, Preview HTML |
| Terminal | 194 | New terminal, Terminal {n} |
| Branch / Commit / PR | 181 / 154 / 143 | Base branch, See commits, View pull request |
| Worktree | 175 | In a worktree, Delete worktree |
| Hooks | 135 | Hooks, hook feedback |
| Remote Control | 119 | Set up Remote Control |
| Subagentes | 86 | Subagents, Failed agents |
| Effort / Fast mode | 68 / 40 | Max effort, Toggle fast mode |
| Rewind | 55 | Rewind to here, Undo rewind |
| WSL | 49 | WSL session, {distro} (WSL) |
| Auto mode / Bypass | 41 / 37 | Enable auto mode, Bypass permissions mode |
| Compactação / contexto | 37 / 15 | Compact session, Context window |
| Sandbox | 36 | Local sandbox, Strict sandbox mode |
| Side chat | 35 | New side chat, Side chat tabs |
| Auto-fix de PR | 31 | Auto-fix CI & address comments |
| Split view / pop out | 26 | Open in split view, Pop out chat |
| Permission mode / Plan mode / Accept edits | 25 / 11 / 9 | Permission mode: {mode} |
| Output style | 23 | New output style |
| Computer use | 21 | Computer use approval |
| Dispatch | 19 | Dispatch from anywhere |

### 2.7 O que isso muda para o Openclod

1. A arquitetura de referência separa **UI + gerente de sessões** de um
   **harness por sessão em processo próprio**, falando um protocolo de eventos
   (stream-json com mensagens de controle). O Openclod roda o harness dentro do
   processo principal; ver `GAP_ANALYSIS.md` §4.
2. O protocolo stream-json do Claude Code é público (Claude Agent SDK). Um
   adaptador "executor externo" deixaria o Openclod rodar o Claude Code CLI (ou
   Codex/OpenCode, como faz o cdesktop) além do harness próprio.
3. As maiores superfícies que o Openclod não tem: terminal PTY real, worktrees,
   Git/PR, plugins/marketplace, rotinas, side chats, rewind, SSH/WSL, preview
   embutido, split view e hooks.
4. O padrão de confiança de pasta (`checkTrust`/`saveTrust`) e de permissão por
   ferramenta (`onToolPermissionRequest`) confirma o desenho de aprovação, com
   **modos** escolhidos pelo usuário (`permission mode`, `auto mode`,
   `bypass`). Isso combina com o pedido de autonomia configurável.
