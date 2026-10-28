# Extensão do Openclod para o Chrome

O Openclod tem a sua própria extensão (`resources/chrome-extension`, **v0.2.0**) para operar o Chrome que o usuário
já tem aberto — com os logins, as abas e as sessões dele — do mesmo jeito que o "Claude in Chrome". Ela fala com o
app por um host nativo (`openclod-chrome-host.exe`, fonte em `resources/bin/chrome-host/main.go`) e uma ponte HTTP em
`127.0.0.1` protegida por token (`src/main/chrome/bridge.ts`). Nada é exposto fora da máquina.

## Instalar (uma vez)

O Chrome **não permite instalar extensão fora da Chrome Web Store sem uma confirmação do usuário** (não existe
instalação silenciosa para extensões locais). O Openclod deixa isso em dois cliques:

1. **Configurações → Navegador → Instalar integração.** Copia a extensão para uma pasta estável
   (`%APPDATA%\Openclod Desktop\chrome-extension`, que sobrevive a atualizações do app) e registra o host nativo no
   Chrome, Edge, Brave e Chromium (`HKCU`, sem administrador).
2. **Abrir extensões** → ligue o *Modo do desenvolvedor* → **Carregar sem compactação** → escolha a pasta
   (botões **Mostrar pasta** e **Copiar caminho** ajudam; também há um atalho na Área de Trabalho).

O status em Configurações passa a *conectada* e o ícone do Openclod aparece na barra do Chrome. O ID da extensão é
fixo (`iflajofnlenfolhiemmfbonmiinnookf`, derivado da `key` do manifesto), por isso o host nativo já a reconhece.

Para distribuir: `npm run pack:chrome-extension` (ou **Exportar .zip** nas Configurações) gera
`release/openclod-chrome-extension-v0.2.0.zip` com o `manifest.json` na raiz — serve para "Carregar sem compactação"
em outra máquina ou para enviar à Chrome Web Store (publicar exige uma conta de desenvolvedor do usuário; isso não é
feito pelo app).

## O que a v0.2.0 faz

| Recurso | Como funciona |
|---|---|
| Abas do agente | Cada sessão ganha um grupo de abas azul `Openclod · <sessão>`; `browser_open`, `browser_claim_tab` (adota a aba em foco), `browser_tabs`, troca e fechamento. |
| Aviso na página | Enquanto o agente age, a aba mostra um brilho laranja nas bordas e uma pílula **"Openclod está controlando esta aba"** com botão **Parar** (Shadow DOM fechado: a página não vê nem estiliza; o snapshot do agente também não). Some sozinha 15 s depois da última ação. |
| Parar | Botão na página, botão no popup ou atalho **Alt+Shift+S**: o app cancela o turno da sessão (mesmo efeito do botão Parar do app) e a extensão recusa comandos dessa sessão por 4 s. |
| Popup | Estado da conexão (conectado / procurando / desconectado), abas em uso (com "Ir"), **Parar o agente**, **Reconectar**, aviso se o acesso a `file://` está desligado. |
| Ícone | Distintivo `!` vermelho se o app não responde, número laranja com as abas em uso; tooltip com o estado. |
| Console e erros de rede | `browser_console` agora funciona no Chrome real: captura `console.*`, erros da página, promessas rejeitadas, recursos que falharam, `fetch`/XHR com status ≥ 400 (desde que o agente assumiu a aba). |
| Screenshot | Esconde o brilho e a pílula só durante a captura, para o modelo não "ver" nem clicar no aviso. Corrigido: o manifesto agora declara `<all_urls>`, sem o qual `captureVisibleTab` falhava. |
| Atualização | O app compara a versão que o Chrome roda com a do pacote e avisa em Configurações quando é preciso recarregar a extensão em `chrome://extensions`. |
| Reconexão | Heartbeat a cada 10 s, alarme a cada 30 s para acordar o service worker, *backoff* de 1,5 s a 15 s quando o host não existe. O app responde cada `hello`/`heartbeat` com `hello_ack`. |

## Se a extensão não estiver conectada

Em *Chrome existente* sem extensão, o `browser_open` **não falha mais**: abre um Chromium isolado e avisa o modelo
("sem os logins nem as abas do usuário"). Dá para desligar em Configurações → Navegador para exigir o Chrome do
usuário. O modo *Automático* já fazia isso.

## Limites conhecidos

- Só Windows hoje (host nativo e registro `HKCU`).
- Páginas `chrome://`, a Chrome Web Store e abas de outras extensões não aceitam scripts: o agente age ali sem o aviso.
- Arquivos locais (`file://`) exigem ligar *Permitir acesso a URLs de arquivo* nos detalhes da extensão (o popup avisa).
- O console só vê o que acontece depois que o agente assumiu a aba/a página atual.
- O Chrome 155 ignora `--load-extension`; os testes carregam a extensão por `Extensions.loadUnpacked` (CDP).
- Um segundo Openclod aberto (outro perfil) executa `taskkill` nos hosts nativos ao iniciar a ponte; a extensão
  reconecta sozinha em segundos, mas o app que perdeu o host pode ficar "desconectado" até o próximo heartbeat.

## Testes

- `tests/chrome-extension-package.test.ts` — o ID derivado da `key`, arquivos e ícones PNG do manifesto, cópia estável, `.zip`.
- `tests/chrome-bridge.test.ts` — token, `hello_ack`, `stop`, coleta do console pela ponte.
- `tests/chrome-extension.test.ts` — **extensão real num Chrome real**, falando com o **host nativo real** e uma
  `ChromeBridge` de teste: conexão, popup, aba agrupada, aviso na página, snapshot sem o aviso, console/erros de rede,
  screenshot sem o aviso, botão Parar → app, recusa do comando seguinte. (Pula sozinho sem Chrome/host registrado.)
- Capturas: `Prints/extensao-chrome-2026-10-27/`.
