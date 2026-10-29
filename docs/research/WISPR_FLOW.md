# Wispr Flow — análise com REA e decisão de implementação

Data: **2026-10-23**. Ferramenta: REA 6.4.0 (`Desktop\REA\rea`), 7-Zip 21.04,
leitura estática do `app.asar` e inspeção do helper nativo. Nenhum código
proprietário foi copiado para o Openclod; o que segue é comportamento observável e
uma implementação independente.

## 1. Cadeia de distribuição (fatos)

| Etapa | Evidência |
|---|---|
| Instalador fornecido | `WisprFlowInstaller.exe`, 6.176.632 bytes, SHA-256 `f7e114a361af2d6efad2b660e7d13cb7cf7163fbfec168784781954eeca4a8ee`. PE x64, .NET NativeAOT (`WisprFlowInstaller.dll`, `1.0.0+c773b475...`), assinado. |
| Manifesto público | `https://dl.wisprflow.com/wispr-flow/win32/latest.json` → payload `Wispr%20Flow%20Setup-v1.6.1253.exe`, 332.356.472 bytes, SHA-256 `8b3e97d0083a3283832d196ae2a307f08bd9f7562855170d9ebd0b4f25307e58`. |
| Formato do payload | Instalador **Squirrel.Windows**: `Update.exe`, `RELEASES`, `WisprFlow-1.6.1253-full.nupkg` (331 MB), `background.gif`, `setupIcon.ico`. |
| Aplicação | **Electron 42.11.2** (`Wispr Flow.exe`, `resources/app.asar` 131 MB, `node_sqlite3.node`, `crypt32-x64.node`). |
| Telemetria | Sentry (`@sentry/electron`, DSN em `status/index.js`) e PostHog (`us.i.posthog.com/capture/`). |
| Conta/backend | Supabase, WorkOS, `notes.wisprflow.ai`; e-mail de suporte `support@wisprflow.ai`. |

O `Claude Setup_7.exe` citado no prompt original é um bootstrapper parecido
(7,2 MB), mas **não** é o Wispr Flow. O instalador do Wispr Flow é o arquivo
acima; o payload real só é baixado pelo manifesto.

## 2. Arquitetura do aplicativo (fatos do `app.asar`)

`app.asar` contém 874 arquivos, com estes bundles principais:

| Arquivo | Tamanho | Papel |
|---|---:|---|
| `.webpack/main/index.js` | 10,1 MB | processo principal: janelas, IPC, auth, backend, banco |
| `.webpack/renderer/overlay/index.js` | 674 KB | **a pílula flutuante** (status bar / overlay) |
| `.webpack/renderer/status/index.js` | 1,3 MB | janela de status e ajustes rápidos |
| `.webpack/renderer/contextMenu/index.js` | 987 KB | menu de contexto do app em foco |
| `.webpack/renderer/accessibility_drop/index.js` | 685 KB | permissões de acessibilidade no macOS |
| `.webpack/renderer/hub/index.js` | 6,0 MB | painel principal (histórico, dicionário, stats) |
| `.webpack/renderer/meeting_recorder/index.js` | 2,2 MB | gravação de reuniões |
| `.webpack/main/opusEncoder.worker.js` | 592 KB | encoder Opus em WebAssembly/worker |
| `.webpack/main/incrementalOpusEncoder.worker.js` | 589 KB | encoder incremental (streaming) |
| `native_modules/build/Release/node_sqlite3.node` | 1,9 MB | histórico local em SQLite |
| `native_modules/lib/crypt32-x64.node` | 118 KB | criptografia no Windows |

Módulos nativos adicionais: conector **Jabra** (headset), `System.Text.Json`,
`GNAudio.*` — integração com microfones/headsests Jabra.

## 3. Fluxo de ditado (fatos + inferência marcada)

Eventos observados no bundle `overlay/index.js`:

- `status:startClicked`, `status:stopClicked`, `status:cancelClicked`,
  `status:barHidden`, `status:barVisible`.
- `dictation:audioSetup`, `dictation:audioStart`, `dictation:audioChunk`,
  `dictation:audioStop`, `dictation:recordingDone`,
  `dictation:recordingStarted`, `dictation:recordingAborted`,
  `dictation:micAcquisitionFailed`, `dictation:audioContextRecoveryStarted`,
  `dictation:audioClose`.
- `status:triggerPolish`, `status:viewPolishDiff`, `status:polishFeedback`.
- `status:requestExtensionIndicator`, `status:extensionStatusBubbleClicked`
  (integração com extensão de navegador).

Fluxo reconstruído:

1. **Atalho global** (`globalShortcut` aparece 8× no main; `pushToTalk` 42×;
   `holdToTalk` 8×). O padrão documentado pela Wispr é `Ctrl+Win` no Windows /
   `Fn` no macOS, com modo "segurar" e modo "alternar".
2. **Microfone no renderer**: `getUserMedia` + `AudioWorklet` (4 ocorrências de
   cada), chunks de áudio enviados por `dictation:audioChunk`.
3. **Opus**: workers `opusEncoder`/`incrementalOpusEncoder` comprimem o áudio.
4. **Transcrição**: `WebSocket` (103 ocorrências), `wss://` (3), `transcript`
   (594), `transcription` (99), `realtime` (65), `Whisper` (9). A leitura
   estática indica **streaming para um serviço remoto** (o nome "Whisper" não
   prova execução local; não há modelos/ONNX no pacote). **Inferência**, não
   fato executado.
5. **Pílula**: janela overlay própria, com estados de gravação, nível e texto;
   a UI principal também tem status/hub.
6. **Limpeza/Polish**: o app chama um passo de "polish" e mostra um diff do
   texto antes/depois; `status:viewPolishDiff`.
7. **Inserção**: o helper nativo (`Wispr Flow Helper.exe`, 19,7 MB, .NET) expõe
   `HelperAPI` com `insertText`, `getSelectedText`, `sendInput`, `UIA`,
   `clipboard`, `paste`, `accessibility` e `hotkey`. O caminho preferido é
   **UI Automation/accessibility**; clipboard + colar e SendInput são fallbacks.
8. **Contexto**: `getSelectedText`/`selectedText` (62×) permitem que o polish
   use o texto selecionado e o aplicativo em foco. `contextMenu`, `tone`,
   `dictionary` e `personalization` aparecem no hub.
9. **Histórico**: SQLite local (`node_sqlite3`), sincronizado com o backend
   (Supabase/WorkOS).
10. **Extensão de navegador**: `extensionBootstrap.js`, `chrome-native-host`-like
    indicators, bolhas de status da extensão.

## 4. O que o Openclod implementa (equivalente independente)

| Capacidade | Openclod | Onde |
|---|---|---|
| Atalho global configurável | `Control+Alt+Space` por padrão; `Control+Alt+J` nos testes | `src/main/dictation.ts`, `src/main/index.ts` |
| Botão de microfone com o mesmo fluxo | clicar no mic chama o mesmo motor global | `src/renderer/src/lib/dictation-store.ts`, `Composer.tsx`, `DictationHost.tsx` |
| Pílula flutuante always-on-top | BrowserWindow transparente, data URL, nível + partial + estado | `src/main/dictation.ts` |
| Microfone | `getUserMedia` + AudioWorklet (`public/pcm-worklet.js`) | `src/renderer/src/lib/voice.ts` |
| STT local | faster-whisper + CTranslate2 + Silero VAD no Python embutido | `resources/stt/openclod_stt.py`, `src/main/stt.ts` |
| Inserção no compositor | evento `dictation:composer`, inserção no caret | `App.tsx`, `Composer.tsx` |
| Inserção em qualquer app | clipboard + `Ctrl+V` via PowerShell (`SendKeys`) | `src/main/dictation.ts` |
| Polish opcional | chamada curta ao provedor padrão, sem ferramentas | `Orchestrator.polishText` |
| Privacidade | áudio e transcrição não saem da máquina; polish é opt-in | `settings.voice.polish` |

Decisões deliberadas:

- **Não copiamos** código, ícones, fontes, prompts ou o helper proprietário.
- **Não usamos** o backend/telemetria da Wispr Flow. O STT é local.
- **Não implementamos** o modo "segurar" ainda: o Electron `globalShortcut` só
  entrega o keydown. O modo atual é alternar (a própria Wispr documenta o modo
  alternar). O modo segurar exige um hook nativo (`WH_KEYBOARD_LL`), que pode
  ser um helper Go/Rust no futuro.
- **Inserção externa** usa clipboard + `Ctrl+V`. É menos preciso que UI
  Automation, mas funciona na maioria dos apps e não exige permissões de
  acessibilidade. O caminho UIA pode ser adicionado com o helper de Computer Use.

## 5. Evidências e reprodução

Artefatos baixados (pasta `repositorios/wisprflow/`, fora do git):

- `WisprFlowSetup-v1.6.1253.exe` (SHA-256 acima).
- `squirrel/` (Update.exe, RELEASES, nupkg).
- `app/lib/net45/` (aplicação Electron extraída).
- `asar-extract/` (bundles principais para leitura).

Comandos usados:

```powershell
node Desktop\REA\rea\scripts\rea.mjs inspect-artifact <installer>
7z l <installer>
7z x <installer> -o<squirrel>
7z x <nupkg> -o<app>
rg -o -N "globalShortcut|pushToTalk|holdToTalk|getUserMedia|AudioWorklet|WebSocket|insertText|getSelectedText|UIA" app.asar
```

Limitações: a análise foi estática; não executamos o app nem o helper. O
`app.asar` é minificado e o helper é .NET compilado; os nomes de API e eventos
são evidência, não prova de cada detalhe de implementação. O payload de nuvem
não foi inspecionado em tráfego.
