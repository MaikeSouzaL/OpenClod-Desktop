# Instalação, build e desinstalação

Guia reproduzível para Windows 10/11 x64. Cobre: preparar a máquina, rodar em
desenvolvimento, gerar o instalador NSIS, verificar o artefato, assinar (opcional)
e desinstalar de forma limpa.

## 1. Pré-requisitos

| Item | Versão | Verificação |
|---|---|---|
| Windows | 10 ou 11, x64 | `[Environment]::Is64BitOperatingSystem` deve retornar `True` |
| Node.js | **22.12+ (22 LTS recomendado)** | `node -v` |
| npm | 10+ | `npm -v` |
| Git | opcional (ferramentas de git do app) | `git --version` |
| Chrome/Edge | opcional (navegador Playwright) | — |
| open-computer-use | opcional (Computer Use) | `npm ls -g @opensymph/open-computer-use` |

> **Por que 22.12+ e não apenas 20?** O `package.json` do `electron@45` declara
> `engines.node >= 22.12.0`. Com Node 20 o `npm install` pode emitir `EBADENGINE`
> e o download/pós-instalação do Electron pode falhar. Use Node 22 LTS.

O aplicativo **empacotado** não exige Node instalado; o Electron leva o próprio
runtime. Node é necessário apenas para desenvolver, testar e empacotar.

## 2. Instalação reproduzível a partir do código

```powershell
# Confirme a versão do Node antes de tudo
node -v            # v22.x
npm -v             # 10.x ou 11.x

# Clone/extraia o repositório e entre na pasta
cd C:\caminho\para\Forja

# Instalação reprodutível (usa package-lock.json)
npm ci

# Alternativa quando não houver lockfile ou em desenvolvimento:
# npm install
```

`npm ci` é o caminho recomendado para CI e para garantir as versões exatas do
`package-lock.json` (inclusive `electron@45.0.0` e `playwright@1.64.1`).

### 2.1 Rodar em desenvolvimento

```powershell
npm run dev
```

- O `electron-vite dev` sobe o renderer com recarga e abre a janela do Electron.
- Log do processo principal: `%APPDATA%\Forja\logs\main.log`.
- DevTools: `F12` ou `Ctrl+Shift+I`.

### 2.2 Verificações antes de empacotar

```powershell
npm run typecheck   # tsc nos projetos node e web
npm test            # Vitest (núcleo)
npm run build       # typecheck + electron-vite build → out/
npm start           # electron-vite preview (abre o build)
```

Se `npm run build` falhar no typecheck, corrija antes de gerar o instalador.

## 3. Gerar o instalador NSIS

### 3.1 Comando único

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

Use quando já tiver rodado `npm run build` e quiser apenas reempacotar.

### 3.3 Build sem instalador

```powershell
npm run dist:dir
```

Gera `release/win-unpacked/` com `Forja.exe` — útil para testar antes do NSIS.

### 3.4 Configuração usada

O empacotamento é definido por **`electron-builder.yml`** na raiz. Esse arquivo
tem precedência sobre o bloco `build` do `package.json`.

| Chave | Valor |
|---|---|
| `appId` | `com.forja.desktop` |
| `productName` | `Forja` |
| `directories.output` | `release` |
| `directories.buildResources` | `build` |
| `files` | `out/**/*`, `package.json` (+ `node_modules/**/*` de produção) |
| `win.target` | `nsis`, `x64` |
| `artifactName` | `Forja-Setup-${version}.${ext}` |
| `nsis.oneClick` | `false` (instalador assistido) |
| `nsis.perMachine` | `false` (instala por usuário) |
| `nsis.allowToChangeInstallationDirectory` | `true` |
| `nsis.createDesktopShortcut` | `true` |
| `nsis.shortcutName` | `Forja` |
| `nsis.deleteAppDataOnUninstall` | `false` (mantém `%APPDATA%\Forja`) |

### 3.5 Artefatos esperados

```
release\
  Forja-Setup-0.1.0.exe          instalador NSIS
  win-unpacked\
    Forja.exe                    executável sem instalador
    resources\app.asar           código empacotado
    ...                          runtime Electron/Chromium
  builder-effective-config.yaml  configuração efetiva do build
```

- O nome do `.exe` segue `Forja-Setup-<versão>.exe`; a versão vem de
  `package.json` (`0.1.0` nesta versão).
- `release/` está no `.gitignore`; não versione artefatos.
- `latest.yml` só aparece se publicação/auto-update for configurada (não é o caso).

### 3.6 Ícones (opcionais)

Não há binários de ícone versionados. Para uma build com identidade visual:

| Arquivo | Uso | Formato |
|---|---|---|
| `build/icon.ico` | Ícone do `.exe` e do instalador NSIS | ICO com 16, 24, 32, 48, 64, 128 e 256 px |
| `build/icon.png` | Ícone da janela em produção (`extraResources`) | PNG 512×512 |

Sem esses arquivos:

- o electron-builder usa o ícone padrão do Electron;
- a janela usa o ícone padrão;
- o build **não falha**, porque `win.icon` e `extraResources` estão comentados no
  YAML de propósito.

Para exigir o ícone (e falhar cedo se ele não existir), descomente `win.icon` e
`extraResources` em `electron-builder.yml`. Veja `build/README.md`.

### 3.7 Limpeza de build (reprodução do zero)

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

1. Execute `release\Forja-Setup-0.1.0.exe`.
2. O NSIS é assistido (`oneClick: false`): escolha o diretório de instalação.
   O padrão por usuário é `%LOCALAPPDATA%\Programs\Forja`.
3. Cria atalho na área de trabalho e no Menu Iniciar com o nome **Forja**.
4. Abra o Forja e confira **Configurações → Sobre**: versão do app, Electron,
   Chromium, Node e plataforma.

### 4.1 Verificação pós-instalação

1. **Configurações → Provedores**: escolha um provedor, salve, grave a chave e
   clique em **Testar**. Sem chave, use **Scripted** apenas para autoteste.
2. **Configurações → Permissões**: mantenha `Perguntar` (padrão) e revise as
   raízes extras.
3. **Configurações → Sobre → Capacidades detectadas**: confirme navegador e
   Computer Use.
4. Adicione uma pasta de projeto, crie uma sessão `ask` e peça uma leitura de
   arquivo. Peça um comando e confirme que a aprovação aparece.
5. Feche e reabra: a sessão deve continuar listada.

## 5. Assinatura de código (caveat)

O build padrão **não é assinado**. Consequências:

- O Windows SmartScreen pode exibir "O Windows protegeu o seu PC" e exigir
  **Mais informações → Executar assim mesmo**.
- Antivírus podem sinalizar o instalador NSIS não assinado.
- Não há auto-update, então não há risco de atualização não assinada.

Para assinar (opcional, requer certificado de code signing):

```powershell
$env:CSC_LINK = "C:\caminho\certificado.pfx"
$env:CSC_KEY_PASSWORD = "senha-do-pfx"
npm run dist
```

- Para certificado em token/HSM (EV), use o suporte a `signtool`/provedor de
  assinatura do electron-builder ou assine o `.exe` manualmente após o build.
- Nunca grave o `.pfx` nem a senha no repositório. Use variáveis de ambiente ou
  o cofre da CI.
- Verifique a assinatura:

  ```powershell
  Get-AuthenticodeSignature .\release\Forja-Setup-0.1.0.exe |
    Format-List Status, SignerCertificate, TimeStamperCertificate
  ```

- Sem certificado, não prometa instalação "sem aviso": o SmartScreen continuará
  alertando em máquinas novas.

## 6. Desinstalação limpa

### 6.1 Fechar o aplicativo

Feche a janela e confirme no Gerenciador de Tarefas que não há `Forja.exe`
(processos filhos de shell/browser podem permanecer se um turno estiver ativo;
abortar o turno antes de fechar evita isso).

### 6.2 Desinstalar pelo Windows

1. **Configurações → Aplicativos → Aplicativos instalados** no Windows 11
   (no Windows 10: **Configurações → Aplicativos → Aplicativos e recursos**).
2. Localize **Forja** e escolha **Desinstalar**.
3. Confirme.

Alternativas:

```powershell
# Desinstalador padrão (instalação por usuário)
& "$env:LOCALAPPDATA\Programs\Forja\Uninstall Forja.exe"

# Silencioso (sem interface)
& "$env:LOCALAPPDATA\Programs\Forja\Uninstall Forja.exe" /S
```

O desinstalador remove:

- `%LOCALAPPDATA%\Programs\Forja` (ou o diretório escolhido na instalação);
- atalho da área de trabalho e do Menu Iniciar;
- entrada de desinstalação em
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall`.

### 6.3 Remover os dados (opcional)

Como `deleteAppDataOnUninstall: false`, os dados do usuário **permanecem**:

```
%APPDATA%\Forja\
  config\settings.json
  config\secrets.bin        ← chaves cifradas com DPAPI
  data\projects.json
  data\sessions\*.json
  data\sessions\*.events.jsonl
  data\memory\*.json
  skills\*\SKILL.md
  logs\main.log
```

Para remoção completa:

```powershell
# 1. Backup opcional antes de apagar
Copy-Item -Recurse "$env:APPDATA\Forja" "$env:USERPROFILE\Desktop\Forja-backup"

# 2. Apagar configurações, chaves, sessões, memória, skills e logs
Remove-Item -Recurse -Force "$env:APPDATA\Forja"

# 3. Garantir que não sobrou pasta de instalação
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\Programs\Forja" -ErrorAction SilentlyContinue

# 4. Atalhos residuais (se existirem)
Remove-Item -Force "$env:USERPROFILE\Desktop\Forja.lnk" -ErrorAction SilentlyContinue
Remove-Item -Force "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Forja.lnk" -ErrorAction SilentlyContinue
```

> As chaves em `secrets.bin` são cifradas com DPAPI do usuário. Apagar o arquivo
> invalida as chaves; não há como recuperá-las sem o backup e o mesmo usuário do
> Windows. Se você só quer trocar de provedor, prefira remover a chave pela UI.

### 6.4 Verificação de desinstalação limpa

- `Test-Path "$env:LOCALAPPDATA\Programs\Forja"` → `False`.
- `Test-Path "$env:APPDATA\Forja"` → `False` (se você removeu os dados).
- Nenhum `Forja.exe` no Gerenciador de Tarefas.
- Nenhum atalho **Forja** na área de trabalho/Menu Iniciar.
- **Aplicativos instalados** sem entrada **Forja**.

## 7. Problemas comuns de instalação/build

| Sintoma | Causa | Solução |
|---|---|---|
| `EBADENGINE` no `npm install` | Node < 22.12 | Instale Node 22 LTS e remova `node_modules` antes de reinstalar |
| Download do Electron falha | proxy/firewall | Configure proxy do npm ou `ELECTRON_MIRROR`; repita `npm ci` |
| `Cannot find module ...` ao abrir o app | build incompleto | `npm run build` e reinstale; confira `out/main/index.js` |
| Build falha em `win.icon` | `build/icon.ico` ausente e `win.icon` descomentado | Gere o ícone ou comente a linha |
| Instalador não abre | bloqueio do SmartScreen/antivírus | Assine o binário ou use "Executar assim mesmo" em ambiente controlado |
| App abre em branco | erro no renderer/main | veja `%APPDATA%\Forja\logs\main.log`; rode em dev com DevTools |
| Computer Use indisponível | binário opcional ausente | `npm i -g @opensymph/open-computer-use` |
| Navegador indisponível | sem Chrome/Edge/Chromium | instale Chrome/Edge ou `npx playwright install chromium` |

Para detalhes de uso e segurança, volte ao [`README.md`](../README.md). Para
licenças, veja [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
