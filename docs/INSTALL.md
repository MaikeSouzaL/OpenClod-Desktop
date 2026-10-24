# InstalaÃ§Ã£o, build e desinstalaÃ§Ã£o

Guia reproduzÃ­vel para Windows 10/11 x64. Cobre: preparar a mÃ¡quina, rodar em
desenvolvimento, gerar o instalador NSIS, verificar o artefato, assinar (opcional)
e desinstalar de forma limpa.

## 1. PrÃ©-requisitos

| Item | VersÃ£o | VerificaÃ§Ã£o |
|---|---|---|
| Windows | 10 ou 11, x64 | `[Environment]::Is64BitOperatingSystem` deve retornar `True` |
| Node.js | **22.12+ (22 LTS recomendado)** | `node -v` |
| npm | 10+ | `npm -v` |
| Git | opcional (ferramentas de git do app) | `git --version` |
| Chrome/Edge | opcional (navegador Playwright) | â€” |
| open-computer-use | opcional (Computer Use) | `npm ls -g @opensymph/open-computer-use` |

> **Por que 22.12+ e nÃ£o apenas 20?** O `package.json` do `electron@45` declara
> `engines.node >= 22.12.0`. Com Node 20 o `npm install` pode emitir `EBADENGINE`
> e o download/pÃ³s-instalaÃ§Ã£o do Electron pode falhar. Use Node 22 LTS.

O aplicativo **empacotado** nÃ£o exige Node instalado; o Electron leva o prÃ³prio
runtime. Node Ã© necessÃ¡rio apenas para desenvolver, testar e empacotar.

## 2. InstalaÃ§Ã£o reproduzÃ­vel a partir do cÃ³digo

```powershell
# Confirme a versÃ£o do Node antes de tudo
node -v            # v22.x
npm -v             # 10.x ou 11.x

# Clone/extraia o repositÃ³rio e entre na pasta
cd C:\caminho\para\Openclod Desktop

# InstalaÃ§Ã£o reprodutÃ­vel (usa package-lock.json)
npm ci

# Alternativa quando nÃ£o houver lockfile ou em desenvolvimento:
# npm install
```

`npm ci` Ã© o caminho recomendado para CI e para garantir as versÃµes exatas do
`package-lock.json` (inclusive `electron@45.0.0` e `playwright@1.64.1`).

### 2.1 Rodar em desenvolvimento

```powershell
npm run dev
```

- O `electron-vite dev` sobe o renderer com recarga e abre a janela do Electron.
- Log do processo principal: `%APPDATA%\Openclod Desktop\logs\main.log`.
- DevTools: `F12` ou `Ctrl+Shift+I`.

### 2.2 VerificaÃ§Ãµes antes de empacotar

```powershell
npm run typecheck   # tsc nos projetos node e web
npm test            # Vitest (nÃºcleo)
npm run build       # typecheck + electron-vite build â†’ out/
npm start           # electron-vite preview (abre o build)
```

Se `npm run build` falhar no typecheck, corrija antes de gerar o instalador.

## 3. Gerar o instalador NSIS

### 3.1 Comando Ãºnico

```powershell
npm run dist
```

Esse script executa:

1. `npm run build` (`typecheck` + `electron-vite build`);
2. `electron-builder --win nsis`.

### 3.2 Comando direto do electron-builder

```powershell
npx electron-builder --win nsis --x64
```

Use quando jÃ¡ tiver rodado `npm run build` e quiser apenas reempacotar.

### 3.3 Build sem instalador

```powershell
npm run dist:dir
```

Gera `release/win-unpacked/` com `Openclod Desktop.exe` â€” Ãºtil para testar antes do NSIS.

### 3.4 ConfiguraÃ§Ã£o usada

O empacotamento Ã© definido por **`electron-builder.yml`** na raiz. Esse arquivo
tem precedÃªncia sobre o bloco `build` do `package.json`.

| Chave | Valor |
|---|---|
| `appId` | `com.forja.desktop` |
| `productName` | `Openclod Desktop` |
| `directories.output` | `release` |
| `directories.buildResources` | `build` |
| `files` | `out/**/*`, `package.json` (+ `node_modules/**/*` de produÃ§Ã£o) |
| `win.target` | `nsis`, `x64` |
| `artifactName` | `Openclod Desktop-${version}-setup.${ext}` |
| `nsis.oneClick` | `false` (instalador assistido) |
| `nsis.perMachine` | `false` (instala por usuÃ¡rio) |
| `nsis.allowToChangeInstallationDirectory` | `true` |
| `nsis.createDesktopShortcut` | `true` |
| `nsis.shortcutName` | `Openclod Desktop` |
| `nsis.deleteAppDataOnUninstall` | `false` (mantÃ©m `%APPDATA%\Openclod Desktop`) |

### 3.5 Artefatos esperados

```
release\
  Openclod Desktop-0.1.0-setup.exe          instalador NSIS
  win-unpacked\
    Openclod Desktop.exe                    executÃ¡vel sem instalador
    resources\app.asar           cÃ³digo empacotado
    ...                          runtime Electron/Chromium
  builder-effective-config.yaml  configuraÃ§Ã£o efetiva do build
```

- O nome do `.exe` segue `Openclod Desktop-Setup-<versÃ£o>.exe`; a versÃ£o vem de
  `package.json` (`0.1.0` nesta versÃ£o).
- `release/` estÃ¡ no `.gitignore`; nÃ£o versione artefatos.
- `latest.yml` sÃ³ aparece se publicaÃ§Ã£o/auto-update for configurada (nÃ£o Ã© o caso).

### 3.6 Ãcones (opcionais)

NÃ£o hÃ¡ binÃ¡rios de Ã­cone versionados. Para uma build com identidade visual:

| Arquivo | Uso | Formato |
|---|---|---|
| `build/icon.ico` | Ãcone do `.exe` e do instalador NSIS | ICO com 16, 24, 32, 48, 64, 128 e 256 px |
| `build/icon.png` | Ãcone da janela em produÃ§Ã£o (`extraResources`) | PNG 512Ã—512 |

Sem esses arquivos:

- o electron-builder usa o Ã­cone padrÃ£o do Electron;
- a janela usa o Ã­cone padrÃ£o;
- o build **nÃ£o falha**, porque `win.icon` e `extraResources` estÃ£o comentados no
  YAML de propÃ³sito.

Para exigir o Ã­cone (e falhar cedo se ele nÃ£o existir), descomente `win.icon` e
`extraResources` em `electron-builder.yml`. Veja `build/README.md`.

### 3.7 Limpeza de build (reproduÃ§Ã£o do zero)

```powershell
Remove-Item -Recurse -Force out, release -ErrorAction SilentlyContinue
npm ci
npm run build
npm run dist
```

Caches que podem interferir em builds muito antigos:

- Electron: `%LOCALAPPDATA%\electron\Cache`
- electron-builder: `%LOCALAPPDATA%\electron-builder\Cache`
- Playwright (navegadores): `%LOCALAPPDATA%\ms-playwright`
- npm: `npm cache clean --force` (use com cautela)

## 4. Instalar o resultado

1. Execute `release\Openclod Desktop-0.1.0-setup.exe`.
2. O NSIS Ã© assistido (`oneClick: false`): escolha o diretÃ³rio de instalaÃ§Ã£o.
   O padrÃ£o por usuÃ¡rio Ã© `%LOCALAPPDATA%\Programs\Openclod Desktop`.
3. Cria atalho na Ã¡rea de trabalho e no Menu Iniciar com o nome **Openclod Desktop**.
4. Abra o Openclod Desktop e confira **ConfiguraÃ§Ãµes â†’ Sobre**: versÃ£o do app, Electron,
   Chromium, Node e plataforma.

### 4.1 VerificaÃ§Ã£o pÃ³s-instalaÃ§Ã£o

1. **ConfiguraÃ§Ãµes â†’ Provedores**: escolha um provedor, salve, grave a chave e
   clique em **Testar**. Sem chave, use **Scripted** apenas para autoteste.
2. **ConfiguraÃ§Ãµes â†’ PermissÃµes**: mantenha `Perguntar` (padrÃ£o) e revise as
   raÃ­zes extras.
3. **ConfiguraÃ§Ãµes â†’ Sobre â†’ Capacidades detectadas**: confirme navegador e
   Computer Use.
4. Adicione uma pasta de projeto, crie uma sessÃ£o `ask` e peÃ§a uma leitura de
   arquivo. PeÃ§a um comando e confirme que a aprovaÃ§Ã£o aparece.
5. Feche e reabra: a sessÃ£o deve continuar listada.

## 5. Assinatura de cÃ³digo (caveat)

O build padrÃ£o **nÃ£o Ã© assinado**. ConsequÃªncias:

- O Windows SmartScreen pode exibir "O Windows protegeu o seu PC" e exigir
  **Mais informaÃ§Ãµes â†’ Executar assim mesmo**.
- AntivÃ­rus podem sinalizar o instalador NSIS nÃ£o assinado.
- NÃ£o hÃ¡ auto-update, entÃ£o nÃ£o hÃ¡ risco de atualizaÃ§Ã£o nÃ£o assinada.

Para assinar (opcional, requer certificado de code signing):

```powershell
$env:CSC_LINK = "C:\caminho\certificado.pfx"
$env:CSC_KEY_PASSWORD = "senha-do-pfx"
npm run dist
```

- Para certificado em token/HSM (EV), use o suporte a `signtool`/provedor de
  assinatura do electron-builder ou assine o `.exe` manualmente apÃ³s o build.
- Nunca grave o `.pfx` nem a senha no repositÃ³rio. Use variÃ¡veis de ambiente ou
  o cofre da CI.
- Verifique a assinatura:

  ```powershell
  Get-AuthenticodeSignature .\release\Openclod Desktop-0.1.0-setup.exe |
    Format-List Status, SignerCertificate, TimeStamperCertificate
  ```

- Sem certificado, nÃ£o prometa instalaÃ§Ã£o "sem aviso": o SmartScreen continuarÃ¡
  alertando em mÃ¡quinas novas.

## 6. DesinstalaÃ§Ã£o limpa

### 6.1 Fechar o aplicativo

Feche a janela e confirme no Gerenciador de Tarefas que nÃ£o hÃ¡ `Openclod Desktop.exe`
(processos filhos de shell/browser podem permanecer se um turno estiver ativo;
abortar o turno antes de fechar evita isso).

### 6.2 Desinstalar pelo Windows

1. **ConfiguraÃ§Ãµes â†’ Aplicativos â†’ Aplicativos instalados** no Windows 11
   (no Windows 10: **ConfiguraÃ§Ãµes â†’ Aplicativos â†’ Aplicativos e recursos**).
2. Localize **Openclod Desktop** e escolha **Desinstalar**.
3. Confirme.

Alternativas:

```powershell
# Desinstalador padrÃ£o (instalaÃ§Ã£o por usuÃ¡rio)
& "$env:LOCALAPPDATA\Programs\Openclod Desktop\Uninstall Openclod Desktop.exe"

# Silencioso (sem interface)
& "$env:LOCALAPPDATA\Programs\Openclod Desktop\Uninstall Openclod Desktop.exe" /S
```

O desinstalador remove:

- `%LOCALAPPDATA%\Programs\Openclod Desktop` (ou o diretÃ³rio escolhido na instalaÃ§Ã£o);
- atalho da Ã¡rea de trabalho e do Menu Iniciar;
- entrada de desinstalaÃ§Ã£o em
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`.

### 6.3 Remover os dados (opcional)

Como `deleteAppDataOnUninstall: false`, os dados do usuÃ¡rio **permanecem**:

```
%APPDATA%\Openclod Desktop\
  config\settings.json
  config\secrets.bin        â† chaves cifradas com DPAPI
  data\projects.json
  data\sessions\*.json
  data\sessions\*.events.jsonl
  data\memory\*.json
  skills\*\SKILL.md
  logs\main.log
```

Para remoÃ§Ã£o completa:

```powershell
# 1. Backup opcional antes de apagar
Copy-Item -Recurse "$env:APPDATA\Openclod Desktop" "$env:USERPROFILE\Desktop\Openclod Desktop-backup"

# 2. Apagar configuraÃ§Ãµes, chaves, sessÃµes, memÃ³ria, skills e logs
Remove-Item -Recurse -Force "$env:APPDATA\Openclod Desktop"

# 3. Garantir que nÃ£o sobrou pasta de instalaÃ§Ã£o
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\Openclod Desktop" -ErrorAction SilentlyContinue

# 4. Atalhos residuais (se existirem)
Remove-Item -Force "$env:USERPROFILE\Desktop\Openclod Desktop.lnk" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Openclod Desktop.lnk" -ErrorAction SilentlyContinue
```

> As chaves em `secrets.bin` sÃ£o cifradas com DPAPI do usuÃ¡rio. Apagar o arquivo
> invalida as chaves; nÃ£o hÃ¡ como recuperÃ¡-las sem o backup e o mesmo usuÃ¡rio do
> Windows. Se vocÃª sÃ³ quer trocar de provedor, prefira remover a chave pela UI.

### 6.4 VerificaÃ§Ã£o de desinstalaÃ§Ã£o limpa

- `Test-Path "$env:LOCALAPPDATA\Programs\Openclod Desktop"` â†’ `False`.
- `Test-Path "$env:APPDATA\Openclod Desktop"` â†’ `False` (se vocÃª removeu os dados).
- Nenhum `Openclod Desktop.exe` no Gerenciador de Tarefas.
- Nenhum atalho **Openclod Desktop** na Ã¡rea de trabalho/Menu Iniciar.
- **Aplicativos instalados** sem entrada **Openclod Desktop**.

## 7. Problemas comuns de instalaÃ§Ã£o/build

| Sintoma | Causa | SoluÃ§Ã£o |
|---|---|---|
| `EBADENGINE` no `npm install` | Node < 22.12 | Instale Node 22 LTS e remova `node_modules` antes de reinstalar |
| Download do Electron falha | proxy/firewall | Configure proxy do npm ou `ELECTRON_MIRROR`; repita `npm ci` |
| `Cannot find module ...` ao abrir o app | build incompleto | `npm run build` e reinstale; confira `out/main/index.js` |
| Build falha em `win.icon` | `build/icon.ico` ausente e `win.icon` descomentado | Gere o Ã­cone ou comente a linha |
| Instalador nÃ£o abre | bloqueio do SmartScreen/antivÃ­rus | Assine o binÃ¡rio ou use "Executar assim mesmo" em ambiente controlado |
| App abre em branco | erro no renderer/main | veja `%APPDATA%\Openclod Desktop\logs\main.log`; rode em dev com DevTools |
| Computer Use indisponÃ­vel | binÃ¡rio opcional ausente | `npm i -g @opensymph/open-computer-use` |
| Navegador indisponÃ­vel | sem Chrome/Edge/Chromium | instale Chrome/Edge ou `npx playwright install chromium` |

Para detalhes de uso e seguranÃ§a, volte ao [`README.md`](../README.md). Para
licenÃ§as, veja [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

