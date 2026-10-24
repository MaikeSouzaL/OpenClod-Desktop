# Execução e evidências

Leia antes de executar o primeiro caso da rodada. Este arquivo diz **como** rodar cada caso do
`cobertura.json` e **como provar** o resultado. O que testar está em `references/catalogo-de-testes.md`;
como descobrir o projeto e montar o ledger, em `references/perfil-e-inventario.md`; o que fazer com
um defeito, em `references/correcao-e-relatorio.md`.

Regra que governa tudo aqui: **um caso só sai de `pendente` com evidência ligada a ele.** "Passou"
sem print, payload ou consulta é opinião, não QA.

## Sumário

0. Antes do primeiro clique (preflight da rodada)
1. Camadas de execução e a ordem — 1.1 Estático e testes existentes · 1.2 API direta, com a sessão
   do usuário ou com credencial sem login · 1.3 Outros tipos de projeto (mobile nativo, CLI e
   biblioteca, job e fila, LLM, desktop)
2. Ferramentas de navegador: qual usar — 2.1 Print em arquivo · 2.2 UI web sem a sessão do usuário
3. Interação confiável — 3.1 a 3.10 (checagem, elemento certo, coordenadas, digitar, aba, tempo,
   mensagens que somem, espião de rede, layout, simular falha e ambiente do cliente)
4. Prova — 4.1 Rede · 4.2 Banco, somente leitura · 4.3 Efeitos a jusante · 4.4 Tempo e console
5. Evidências — 5.1 Print de absolutamente tudo · 5.2 Nome dos arquivos · 5.3 Nitidez · 5.4 Circular o
   problema · 5.5 Ligar ao ledger e à nota
6. Anti-falso-positivo — 6.1 Sintoma → causa a descartar → como · 6.2 Outro caminho · 6.3 Verificação
   adversarial · 6.4 Retratação
7. Dados de teste
8. Quando não dá para executar
9. Cartão por caso
10. Comandos de referência e códigos de saída — 10.1 Ledger · 10.2 Diff, provas, PDF e aprendizado ·
    10.3 Códigos de saída

---

## 0. Antes do primeiro clique (preflight da rodada)

Faça na ordem e registre em `notas/00-preflight.md`:

1. **Ambiente de verdade, não o do arquivo.** Abra a aplicação e leia na **aba de rede** para qual
   API ela está falando; confirme no banco qual base recebe a conexão. Arquivo de configuração pode
   estar ilegível, sobrescrito por outro `.env` ou apontar para outro lugar.
   Se for produção: somente leitura, sem exceção; gravar só com pedido do usuário no chat para
   aquela ação, registrado na rodada (`cobertura.py rodada --autorizacao`).
2. **Quem está logado em cada aba/janela.** Leia o nome/papel na tela **e** a identidade que a API
   devolve (endpoint de "eu"/perfil, ou o token decodificado sem copiá-lo). Anote papel × aba.
3. **`git status` inicial** do(s) repositório(s). Serve para separar no fim o que é desta rodada do
   que já estava alterado por outra sessão.
4. **Baseline estático** (seção 1): número de erros de tipo/lint/build **antes** de mexer em nada.
5. **Pasta da rodada** criada (`.qa/<AAAA-MM-DD>-<alvo>/` com `notas/`, `evidencias/`, `rede/`) e
   o ledger carregado.
6. **Espião de rede e observador de toast instalados** na aba que vai ser usada (seção 3.8).

---

## 1. Camadas de execução e a ordem

| # | Camada | Quando | O que pega | O que **não** pega |
|---|---|---|---|---|
| 1 | Estático / build | uma vez, no início (baseline) e depois de cada correção | erro de tipo, import quebrado, build que só passa porque ignora erros, lint | qualquer comportamento |
| 2 | Testes automatizados existentes | uma vez, no início, e na regressão | regressão do que alguém já cobriu | o que ninguém escreveu |
| 3 | API direta | para conhecer contratos e para todo caso de **bloqueio** e **isolamento** | autorização real (o front esconde, o back barra?), id trocado, validação do servidor, código HTTP e forma da resposta, campos que a tela não mostra | se a tela chama o endpoint certo |
| 4 | UI na tela real | todo caso que tem tela | integração (o handler certo está ligado), feedback, estado do componente × DOM, fluxo do usuário, layout, a11y, i18n | o que foi de fato gravado |
| 5 | Banco (somente leitura) | depois de toda escrita | o que gravou, o que **não** devia mudar, duplicata, órfão, campo descartado em silêncio | o que o usuário vê |
| 6 | Efeitos a jusante | depois de toda ação que gera algo | e-mail, notificação, documento, registro derivado, contador, listagem, auditoria — com o **conteúdo** certo | — |

**Por que todas, e nessa ordem.** Cada camada mente de um jeito que só a seguinte desmascara:

- A tela diz "Salvo com sucesso" e o corpo enviado não leva o campo (só a **rede** mostra).
- O corpo leva o campo e o servidor o descarta para aquele papel (só o **banco** mostra).
- O endpoint só insere, cria uma segunda linha a cada edição e a leitura devolve a mais antiga:
  a tela "não salva" sem erro nenhum (só **banco + tela recarregada** mostram).
- O botão some para o papel sem permissão e o endpoint aceita a chamada direta (só a **API
  direta** mostra).
- O registro derivado existe, mas sai sem o dado que identifica o caso (só abrir o **efeito a
  jusante** mostra).

As camadas 1 e 2 são linha de base: sem elas, um erro que já existia vira "regressão sua". As
camadas 3 a 6 formam a **cadeia de prova de cada caso**: ação → rede → banco → jusante.

### 1.1 Estático e testes existentes

- Rode o verificador de tipos/lint/build do projeto (o PERFIL diz qual: `tsc --noEmit`,
  `mypy`, `cargo check`, `go vet`, `dotnet build`, `./gradlew check`…). Anote o **número** de erros.
  Build configurado para ignorar erro de tipo **não** conta como verificação de tipo.
- Rode a suíte existente. Anote passou/falhou/pulado **antes** de qualquer mudança.
- Falha pré-existente vira **achado no ledger**, não algo a "consertar" ajustando o teste até passar.
- Depois de cada correção: o número de erros não pode subir do baseline.

### 1.2 API direta, com a sessão do usuário ou com credencial sem login

Use o que o PERFIL autoriza. O jeito mais seguro é chamar **de dentro da página logada**, para a
credencial nunca sair do navegador:

```js
// javascript_tool (extensão) ou browser_evaluate (Playwright). Ajuste a chave do token ao PERFIL.
const tk = sessionStorage.getItem('<chave-do-token>') || localStorage.getItem('<chave-do-token>');
const r = await fetch('/api/<recurso>/<id-de-outro-dono>', {
  headers: tk ? { Authorization: 'Bearer ' + tk } : {},
  credentials: 'include'
});
({ status: r.status, corpo: (await r.text()).slice(0, 2000) });
```

- No Playwright, envolva em função assíncrona: `async () => { ...; return { status, corpo } }`.
- **Nunca** devolva, imprima ou grave o token. O snippet acima só devolve status e corpo.
- Leitura (GET) com id trocado é o teste de isolamento: deve dar 403/404, nunca o dado do outro.
- Escrita direta (testar se o servidor barra o que o front esconde) **só fora de produção**, só
  com autorização da rodada e só sobre dado criado pelo próprio teste. Se o servidor **não**
  barrar, a escrita aconteceu: registre o defeito **e** a sujeira.
- Projeto só de API: esta camada é a "tela". Use o cliente HTTP do projeto (coleção, `curl`,
  `httpie`) e salve requisição e resposta em `rede/NN-<chamada>.json`, sem cabeçalhos de auth.
- **Sem navegador (API pura, CLI, job):** a credencial de teste de cada papel vem do usuário (PERFIL
  §6, "Credencial por papel sem login"), por um de dois caminhos, e é lida **dentro do próprio
  comando**, nunca impressa nem gravada:
  - **(a) variável de ambiente** (ex.: `QA_TOKEN_ADMIN`): só vale se estiver no perfil do shell ou no
    ambiente que iniciou o Claude Code. Cada chamada de ferramenta abre um shell novo, então um
    `export` feito noutro terminal no meio da sessão não chega;
  - **(b) arquivo de cabeçalho fora do repositório** (ex.: `$QA_CRED_DIR/admin.header`, com a linha
    `Authorization: Bearer …`), que o usuário cria sem reiniciar a sessão; o curl lê com
    `-H @arquivo` (curl 7.55 ou mais novo).

  Grave o **resumo** da chamada num JSON que nunca sai vazio, e o corpo à parte. Com só `-o` e o status
  no terminal, um 401, 403, 404 ou 204 sem corpo deixa um arquivo de 0 byte, que o gate recusa, e o
  status, que é a prova do bloqueio (IDOR, tenant), não fica em lugar nenhum:

  ```bash
  curl -s -o rede/12-get-pedido-outro-tenant.corpo \
    -w '{"metodo":"%{method}","url":"%{url_effective}","status":"%{http_code}","tempo_s":%{time_total},"bytes":%{size_download}}\n' \
    -H @"$QA_CRED_DIR/admin.header" "https://<host-de-teste>/api/<recurso>/<id-de-outro-dono>" \
    > rede/12-get-pedido-outro-tenant.json
  ```

  - A evidência ligada ao caso é o `.json`; o `.corpo` entra junto só se tiver conteúdo. O status vai
    entre aspas porque falha de conexão sai `000`, que não é número JSON válido. `%{method}` pede
    curl 7.72 ou mais novo; sem ele, escreva o método à mão no `-w`.
  - Com a variável em vez do arquivo: `-H "Authorization: Bearer $QA_TOKEN_ADMIN"`.
  - Nunca ponha token na query string: ela aparece no `url_effective` e vai para o `.json`.
  - Sem a credencial (variável vazia ou arquivo ausente), o caso fica `bloqueado` com "falta a
    credencial de teste do papel X; destrava: o usuário criar o arquivo ou a variável"; nunca peça a
    senha nem faça login para obter um token.

### 1.3 Outros tipos de projeto

| Projeto | "Tela" | Evidência |
|---|---|---|
| Web front / full-stack | o navegador (seção 2) | print + `rede/*.json` + consulta |
| API / backend | o cliente HTTP | `rede/*.json` (requisição e resposta) + consulta + log do servidor |
| Mobile | emulador/simulador ou aparelho, via computer-use (nativo) ou Playwright/DevTools (webview) | print do emulador (`adb exec-out screencap -p`, `xcrun simctl io booted screenshot`) + log (`adb logcat`, console) + rede + dump da hierarquia de UI do estado (ver "Mobile nativo" abaixo) |
| CLI | o terminal, cada caso com pasta de trabalho e configuração temporárias; prompt e TUI sob pseudo-terminal (ver "CLI e biblioteca" abaixo) | transcrição com comando, `stdout`, `stderr` e **código de saída** em `evidencias/NN-<caso>.txt`; arquivos gerados conferidos |
| Biblioteca | a API pública **do pacote empacotado** com destino fora do projeto, instalado num consumidor no scratch e chamado por script ou REPL (ver "CLI e biblioteca" abaixo) | script do caso + saída em `evidencias/NN-<caso>.txt`; exemplos da documentação executados de verdade |
| Job / fila | o comando ou endpoint de trigger em dev, ou uma mensagem de teste numa **fila de teste** (nunca a de produção) | linha da tabela de execuções, profundidade da fila e da DLQ antes e depois, e o log pelo correlation id, em `evidencias/NN-<caso>.txt`; efeito a jusante conferido |
| App com modelo de linguagem | a tela ou a API do app, com a mesma entrada repetida N vezes | entrada, saída, modelo e versão, temperatura (e seed), tokens, custo e as N execuções em `evidencias/NN-<caso>.jsonl`; a taxa de acerto contra o critério e o limiar do conjunto de avaliação; ferramentas chamadas pelo agente |
| Desktop (Electron/Tauri) | o app aberto pelo Playwright `_electron.launch` (Electron), pelo `tauri-driver` com WebDriver (Tauri) ou por computer-use com print da janela; o driver fica no PERFIL §1.1 | print da janela + log do processo principal; arquivos tocados no perfil do usuário registrados em `sujeira` |
| Jogo / canvas | a página ou o app, com seed fixa quando houver | print + `visual_diff.py` com tolerância + estado de debug lido (ex.: `window.__estado`); marcas em px |
| Site estático | o build publicado (ou o servidor local do gerador) | print por página + lista de links verificados (status) + metadados lidos do HTML |

#### Mobile nativo

O espião de rede e o snippet de elementos são de navegador; no app nativo use:

- **Hierarquia de UI** em cada estado: `adb shell uiautomator dump /sdcard/ui.xml` + `adb pull
  /sdcard/ui.xml evidencias/NN-ui.xml`; `maestro hierarchy`; page source do Appium; no Flutter,
  `integration_test` achando por `Key`. É o equivalente do snippet de elementos e do `elementFromPoint`.
- **Rede:** interceptor de log no build de debug, ou proxy com CA instalada **só no emulador de teste**
  (nunca no aparelho pessoal de alguém).
- **Deep link:** `adb shell am start -W -a android.intent.action.VIEW -d <url>`;
  `xcrun simctl openurl booted <url>`.
- **Permissões:** `adb shell pm grant <pacote> <permissao>` / `pm revoke`; `xcrun simctl privacy
  booted grant <servico> <bundle>` / `revoke`.
- **Rotação, segundo plano e morte do processo:** rotação pelo emulador; `adb shell input keyevent
  KEYCODE_HOME` e voltar; `adb shell am kill <pacote>` com o app em segundo plano (o sistema matando o
  processo, não o usuário fechando).
- **Push:** `xcrun simctl push booted <bundle> payload.apns`; no Android, o modo de teste do provedor
  de push ou o receiver de debug do próprio app. Push real para aparelho de pessoa é efeito externo.
- **Tema:** `adb shell cmd uimode night yes|no`; `xcrun simctl ui booted appearance dark|light`.
- **Fonte do sistema:** `adb shell settings put system font_scale 1.3`;
  `xcrun simctl ui booted content_size extra-extra-large`.
- **Cortar a rede:** `adb shell cmd connectivity airplane-mode enable|disable`, ou `adb shell svc wifi disable` e
  `svc data disable`; no iOS, o Network Link Conditioner.
- **Locale e fuso:** pelas configurações do emulador, com o valor usado registrado na nota.
- Tudo isso **só no emulador ou aparelho de teste**, nunca no aparelho pessoal de alguém. Volte cada
  ajuste ao valor de antes no fim; o que não voltar vai para `sujeira`.
- **Build:** registre se foi debug ou release; o que passa em um pode falhar no outro.
- **Acessibilidade:** TalkBack/VoiceOver no lugar do axe.
- **Marcas no print:** use os `bounds` do dump, que já estão em px do print:
  `circular.py <print> --marcas <json> --escala 1`.

#### CLI e biblioteca

- **Pasta e configuração temporárias.** Cada caso de CLI roda com `cwd` numa pasta temporária do
  scratch e com `HOME`, `XDG_CONFIG_HOME`, `APPDATA`, `LOCALAPPDATA` e `USERPROFILE` apontando para
  pastas temporárias, para o comando não ler nem gravar a configuração real do usuário. Caso que
  precisa da configuração real só lê.
- **Prompt e TUI sob pseudo-terminal.** Com o stdin redirecionado pela ferramenta de shell, o programa
  costuma detectar "não é TTY" e pular o prompt: o teste não exercita o que o usuário vê. Rode sob
  pseudo-terminal: `pexpect`, ou `python -c "import pty; pty.spawn(['<cmd>', '<arg>'])"` no POSIX,
  `script -q -c "<cmd>" /dev/null` (Linux) ou `script -q /dev/null <cmd>` (macOS), `winpty <cmd>` no
  Windows. A transcrição vai para `evidencias/NN-<caso>.txt`.
- **Caso separado "stdin não TTY"** para toda operação destrutiva (`PJ-CLI-08`): com a entrada
  redirecionada, o comando recusa ou exige `--yes`; nunca executa o destrutivo sem confirmação.
- **Empacotar sem sujar o projeto.** O empacotamento escreve no projeto (o `npm pack` grava o `.tgz`
  na raiz) e os ganchos `prepack`/`prepare` executam código do projeto. Use destino fora dele:
  `npm pack --pack-destination <tmp>`, `cargo package --target-dir <tmp>`, `dotnet pack -o <tmp>`;
  `python -m build --outdir <tmp>` só numa cópia do projeto (o build cria pastas na árvore). O que
  sobrar no projeto vai para `sujeira`.
- **Empacotar falhou: caminho B.** Depois de empacotar, confira o nome do wheel ou do tgz: `UNKNOWN` ou
  `0.0.0` = falhou (setuptools antigo sem metadado; build isolado que precisa baixar do PyPI offline).
  Sem pacote, rode do src com `PYTHONPATH=src` (ou o equivalente da linguagem: `NODE_PATH`, `cargo run`
  no workspace), grave `--obs "artefato: src; pacote bloqueado em C-NNNN"` em cada caso `funcao:` e
  `comando:`, deixe o caso `[PJ-LIB-07]` `bloqueado` com "falta …; destrava: …" e ponha o reteste no
  pacote na ressalva do não validado. O gate exige `[PJ-LIB-07]` passou ou bloqueado com "destrava:", e
  avisa quando um defeito vira `retestado-ok` com ele bloqueado (reteste feito fora do pacote).
- **Executor pronto** (`scripts/executar_caso.py`): grava a transcrição do caso (comando, `stdout`,
  `stderr`, código de saída) em `<rodada>/evidencias/<NN-slug>[-SUFIXO].txt` e imprime o caminho, que vai
  direto em `cobertura.py set <rodada> C-NNNN --evidencia <caminho impresso>`. CLI:
  `executar_caso.py cmd <rodada> --slug 07-foo-vazio --sufixo ANTES --cwd <tmp> --env HOME=<tmp>
  --esperado-rc 2 --contem "uso:" -- foo --bar`. Biblioteca:
  `executar_caso.py chamar <rodada> --slug 08-soma --modulo pacote.modulo --funcao soma --args '[1, 2]'
  --pythonpath <consumidor ou src> --contem 3`. `--stdin ARQ` alimenta a entrada; `--sufixo CORRIGIDO`
  ou `RETESTE` no DEPOIS e no reteste. Prompt e TUI continuam sob pseudo-terminal (acima).
  O "$ <comando>" já sai com o valor de opção de credencial trocado por `[REMOVIDO]`: `--password`,
  `--token`, `--api-key`, `-H` com Authorization ou Cookie, a senha de `usuario:senha` em `curl -u` e
  `http -a`, `mysql -p<senha>`, `sqlcmd -P`, `redis-cli -a`, `mongo`, `sshpass` e `docker login -p`. O shell
  expande `$SENHA` antes de o script ver o argv: prefira `--env NOME=valor` (só o NOME vai para a
  transcrição) e referencie a variável dentro de `sh -c '...'`.

---

## 2. Ferramentas de navegador: qual usar

| Ferramenta | Sessão | O usuário vê? | Use para | Não use para |
|---|---|---|---|---|
| **Extensão do Chrome** (`mcp__claude-in-chrome__*`) | a do usuário, já logada | sim, é o navegador na frente dele | validar na tela, toda tela autenticada, produção (só leitura) | viewport exato (o redimensionamento pode não mudar o `innerWidth`) |
| **Playwright** (MCP `mcp__plugin_playwright_playwright__*`, ou script) | perfil próprio, começa deslogado | só se aberto com janela (headed) | roteiro repetível, `data-testid`, viewport exato (`browser_resize`), corpo de requisição (`browser_network_request`), print direto em arquivo | substituir a validação na sessão do usuário |
| **Navegador integrado / preview** | nenhuma | não | só se o PERFIL permitir explicitamente | qualquer tela autenticada |
| **computer-use** (`mcp__computer-use__*`) | a do sistema | sim | app nativo, emulador, fluxo entre aplicativos | navegador (lá ele só lê; clique e digitação ficam bloqueados) |

Regras:

- **Nunca digite senha nem faça login.** Precisa de outro papel? Peça ao usuário: diga **qual
  usuário/papel**, **em qual aba ou janela** e **o que vai ser testado** com ele. Junte os pedidos
  para interromper o mínimo.
- **Teste real na tela que o usuário nomeou.** Vitrine de componentes, mock, página de exemplo e
  leitura de código não validam nada: provam que o componente monta, não que a tela funciona. Se
  não deu para chegar à tela real, o caso fica `nao-validado` (seção 8), nunca `passou`.
- **Playwright sem perfil persistente perde o login a cada sessão.** Use diretório de perfil fixo
  (fora do versionamento) e confira onde ele foi criado de fato: variável em arquivo de
  configuração pode não ser expandida e virar pasta com nome literal. Se abrir a janela para o
  usuário logar, **não feche ao terminar**: fechar derruba a sessão e ele pode querer continuar.
- **Uma sessão por papel.** Cookie é por origem e vale para todas as abas; storage de sessão é por
  aba. Duas pessoas logadas no mesmo navegador podem fazer uma aba renderizar como o usuário da
  outra. Prefira janelas/perfis separados por papel e **confira a identidade antes de cada ação**.
  Nunca apague o cookie de uma aba para "deslogar" a outra.
- **Permissão alterada só vale depois de sair e entrar de novo** quando vem no token. Recarregar
  não basta. Peça o novo login antes de concluir "a permissão não funciona".

### 2.1 Print em arquivo

O screenshot devolvido ao modelo **não é arquivo**. Para virar evidência:

| Ferramenta | Como salvar |
|---|---|
| extensão | `computer` com `action: screenshot` (ou `zoom` com `region`) e `save_to_disk: true`; copie o caminho devolvido para `evidencias/NN-....png` |
| Playwright | `browser_take_screenshot` com `filename` (use `scale: "device"` para texto nítido; `fullPage` só quando precisar da página inteira) |
| computer-use | `screenshot` com `save_to_disk: true` |
| fora das ferramentas | captura do sistema pela janela, filtrando pelo **título** (há várias janelas do mesmo navegador) |

**Olhe o arquivo salvo antes de confiar nele.** Imagem de poucos pixels (ex.: 160×28) é janela
minimizada; imagem toda branca/preta ou desatualizada é aba em segundo plano.

### 2.2 UI web sem a sessão do usuário

Quando o navegador do usuário não pode ser usado (sandbox, CI, regra do projeto) e o app autentica por
token guardado no storage do navegador:

- **Playwright headless com perfil temporário** (`--user-data-dir` numa pasta do scratch, apagada no
  fim), nunca o perfil do navegador do usuário nem o perfil persistente de QA.
- **Credencial de teste fornecida pelo usuário**, pelos mesmos dois caminhos da API (§1.2: variável
  de ambiente ou arquivo fora do repositório). Nunca obtida por login, nunca digitada num campo, nunca
  de produção.
- O script injeta a credencial no storage **antes da primeira navegação** e não a imprime nem grava:

  ```js
  await context.addInitScript(({ chave, valor }) => { sessionStorage.setItem(chave, valor) },
    { chave: '<chave do token, do PERFIL>', valor: process.env.QA_TOKEN_ADMIN })
  ```

  Use `localStorage` no lugar se é lá que o app guarda; com o arquivo (b), o script lê o arquivo e
  passa o valor do mesmo jeito.
- Print, `rede/*.json` e trace sem o storage nem o cabeçalho de autenticação; revise antes de salvar.
- Confira a identidade da sessão pelo endpoint "eu" antes do primeiro caso (§0, item 2).
- Registre no PERFIL (§6, "UI sem sessão do usuário") a chave do storage e de onde a credencial vem.
  Sem credencial, os casos de UI autenticada ficam `bloqueado` com "falta a credencial de teste do
  papel X para a UI sem sessão; destrava: o usuário fornecer a variável ou o arquivo".

---

## 3. Interação confiável

### 3.1 Checagem antes de cada lote de ações

```js
({ vis: document.visibilityState, foco: document.hasFocus(), url: location.href,
   iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio, sy: scrollY,
   espiao: !!window.__qaEspiaoRede, toast: !!window.__qaObservadorToast })
```

- `vis: 'hidden'` → aba em segundo plano: screenshot congelado, clique perdido, contagens por
  `setTimeout` andando devagar. Traga a aba para frente ou navegue na aba visível.
- `foco: false` → digitação pode não entrar. Clique no campo (por `ref`) antes de digitar.
- `espiao`/`toast` falsos → a página recarregou; reinstale (seção 3.8).

### 3.2 Achar o elemento certo

Ordem de preferência: **`data-testid`** → **papel + nome acessível** (`ref` do `find`/`read_page`,
`browser_snapshot` no Playwright) → texto visível → coordenada (último recurso).

Muitas páginas montam **cópias ocultas** do mesmo componente (layout responsivo, abas montadas,
duplicata em `display:none`). `offsetParent !== null` não basta. Filtre pelo que tem tamanho
**e** está por cima no ponto de clique:

```js
const visiveis = (sel) => [...document.querySelectorAll(sel)].filter((el) => {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const topo = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return topo === el || el.contains(topo);
});
```

Se `elementFromPoint` devolve outro elemento (lista suspensa que ficou no DOM, balão de chat, toast,
overlay), o clique vai para ele: isso é um achado de layout **ou** um falso negativo esperando para
acontecer. Investigue antes de clicar.

### 3.3 Coordenadas e escala

O quadro do screenshot **não** é o viewport CSS. Meça o fator e converta:

```js
const fator = innerWidth / <largura-do-screenshot-em-px>;
const r = alvo.getBoundingClientRect();
({ x: Math.round((r.x + r.width / 2) / fator), y: Math.round((r.y + r.height / 2) / fator) });
```

- A altura da janela pode oscilar entre a medição e o clique: **meça e clique no mesmo lote, logo
  depois de um screenshot**. Clique calculado num turno e executado no seguinte erra.
- Zoom do navegador muda o fator. Remeça depois de qualquer mudança de zoom ou tamanho.
- Depois do clique, prove que ele caiu: screenshot, espião (houve chamada?) ou mudança de estado.

### 3.4 Digitar e escolher como um humano

- **Padrão: clique no campo (por `ref`) + digitação real.** Para campo com máscara: clique triplo
  para selecionar + digitação.
- **`form_input` e setters sintéticos podem escrever só no DOM** sem passar pelo `onChange` de
  componente controlado: a tela mostra o valor e o estado da aplicação continua vazio. Depois de
  qualquer preenchimento, prove que o valor entrou no **estado**: o corpo enviado o contém, ou o
  componente re-renderizado o mostra depois de perder o foco.
- Quando a digitação real não serve (ex.: `input type=datetime-local`), use o setter nativo e
  **registre no caso que o valor foi colado/programático**:

  ```js
  const el = document.querySelector('<seletor>');
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
  set.call(el, '2026-10-01T10:30');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  ```

  Isso não funciona para todo componente (moeda mascarada costuma ignorar). Se o estado não mudar,
  volte para a digitação real.
- **Rádio e checkbox customizados**: o `<input>` real costuma estar escondido atrás de um botão.
  Clique no controle **visível** e confira o estado visual e `aria-checked`/`data-state`. Clicar no
  rótulo pode marcar o input e não o visual (ou o contrário).
- **Lista suspensa customizada**: abra pelo botão, escolha pela opção (prefira `data-testid`). A
  lista pode continuar no DOM depois de fechada e engolir o próximo clique por um tempo: feche com
  Esc e confira `elementFromPoint` antes de seguir.
- Digite **tecla a tecla** quando o caso for sobre limite de regra (ex.: 5 → 50 → 51) e confira
  `document.activeElement` a cada passo: campo que remonta perde o foco no meio da digitação.

### 3.5 Aba, janela e foco

- Aba nova aberta pela ferramenta pode nascer em **segundo plano**. Para abrir um link externo do
  fluxo (formulário público, link de e-mail), navegue na aba visível e volte depois.
- Janela minimizada produz print minúsculo e clique perdido: restaure antes.
- Página pesada em segundo plano fica lenta a ponto de estourar o tempo da ferramenta de JS.

### 3.6 Tempo: espere o evento, não o relógio

- **Meça o tempo real** de cada requisição lenta (o espião dá `ms`) e anote as acima de 3 s.
- **Só conclua ausência depois que o evento terminou.** "Esperei X s" só vale se X for maior que o
  tempo do evento. Requisição de 2 minutos com 60 s de espera vira "nunca acontece" — falso.
- Use `await __qa.esperarRede('<trecho>', 20000)` em rodadas curtas e repita enquanto disser
  "ainda pendente". **Nunca clique de novo** num botão cuja requisição está pendente: isso cria a
  duplicata que você depois vai reportar como bug.
- Página que ainda está montando mostra estados intermediários (componentes renderizados antes do
  dado chegar). Leia depois que a chamada de dados daquela tela terminou.
- Ambiente de desenvolvimento pode disparar leituras em dobro (modo estrito de framework). GET
  repetido em dev não é defeito; **escrita** repetida é.

### 3.7 Mensagens que somem (toast, alerta, validação)

- Instale o observador (`scripts/toast-observer.js`) **antes** do clique. Ele grava cru, sem filtro
  de texto: filtrar por "sucesso|erro" já perdeu um "Atenção / Revise os campos!".
- Ele observa `childList + subtree + characterData` porque muitos sistemas de toast reaproveitam o
  mesmo nó e só trocam o texto; observar só `childList` perde o segundo toast.
- Mesmo com o texto capturado, **tire o print em até ~2 s** depois da resposta.
- **Validação inline não é toast nem modal.** Depois de todo clique de ação, procure texto de erro
  visível (`[aria-invalid="true"]`, `role="alert"`, texto em cor de erro) e tire screenshot antes
  de concluir "nada aconteceu".
- Modal nem sempre tem `role="dialog"`: procure pelo título. Teste Esc e clique fora — se fechar
  perdendo o que foi digitado, é um caso.

### 3.8 Espião de rede e observador: instalação

```text
scripts/xhr-spy.js        -> window.__qa.rede, resumo(), ultimo(), json(), duplicadas(),
                             esperarRede(), quadros(), esperarQuadro(), exportar(), limpar()
scripts/toast-observer.js -> window.__qa.toasts, toastsResumo(), toastsAgora(),
                             esperarToast(), toastsLimpar(), toastsParar()
```

- Cole o conteúdo inteiro do arquivo na ferramenta de JS (extensão: `javascript_tool`; Playwright:
  `browser_evaluate`), com o retorno certo para cada um:
  - `xhr-spy.js`: `() => { <conteúdo>; return window.__qa.resumo() }`;
  - `toast-observer.js`: `() => { <conteúdo>; return window.__qa.toastsResumo() }`;
  - `axe-inject.js` (MO-8): `async () => { <conteúdo>; return await window.__qa.a11yPromessa }`.
    Ele é assíncrono: sem o `await`, a resposta vem antes da análise, e "nenhuma violação" é falso.
- **Reinstale depois de toda navegação completa** (recarregar, URL nova digitada). Navegação
  interna de SPA mantém os dois.
- Os dois não instalam duas vezes (marca na janela). Espião duplicado faz cada chamada aparecer em
  dobro e parece requisição duplicada.
- O espião cobre **XHR, fetch, WebSocket e EventSource**: um espião só de `fetch` não vê nada em
  app que usa axios, e um só de HTTP não vê chat, app em tempo real nem streaming de modelo de
  linguagem. Resposta `text/event-stream` por `fetch` é lida até um teto de bytes e de tempo, com os
  eventos agregados. WebSocket aberto **antes** da instalação só aparece a partir do primeiro envio
  depois dela; para ver a conexão inteira, no Playwright use `page.on('websocket')`.
- O filtro aceita trecho de URL, URL absoluta ou `"MÉTODO /caminho"` (`"POST /api/v1/cliente"`), `RegExp`
  ou função; WebSocket aparece como método `WS` e EventSource como `SSE`.
- Corpos e quadros com nome de segredo (senha, token, JWT, cookie, sessão, api key, client secret)
  saem como `***`, e JWT solto no texto também; cabeçalhos não são gravados. Mesmo assim, revise o
  JSON antes de salvar.
- Antes de cada ação que vai provar: `__qa.limpar(); __qa.toastsLimpar()`.

### 3.9 Medir layout e responsivo

- **Número que não muda quando a entrada muda é sinal de medição quebrada**, não de robustez.
  Ex.: estilo aplicado por script sem efeito porque o CSS usa `!important` (use
  `el.style.setProperty('width', '380px', 'important')`), ou redimensionar a janela sem o
  `innerWidth` mudar.
- Depois de redimensionar, confira `innerWidth` e `matchMedia('(min-width: Npx)').matches`. Se não
  mudaram, use viewport exato (Playwright `browser_resize`).
- Cor e contraste: leia `getComputedStyle` do elemento **visível** e meça a razão de contraste;
  não estime pelo nome da classe.

### 3.10 Simular falha e ambiente do cliente

API fora, rede lenta, offline, sessão expirada, fuso e idioma do cliente, impressão e relógio
(`DM-FAL-01/03/04`, `DM-SES-01`, `DM-RES-07`, `MA-2-06`, `PJ-JOB-01`) se provocam **sem derrubar o
serviço nem a sessão de ninguém**: só no perfil de QA do Playwright ou numa aba de teste, nunca na
sessão logada do usuário e nunca em produção.

```js
await page.route('**/api/x', (r) => r.fulfill({ status: 500, body: '{"erro":"simulado"}' }))  // API com erro
await page.route('**/api/x', (r) => r.abort())                                                  // API fora
await page.route('**/api/x', (r) => setTimeout(() => r.continue(), 8000))                       // rede lenta
await context.setOffline(true)                                                                  // offline
await page.route('**/api/x', (r) => r.fulfill({ status: 401 }))   // sessão expirada, sem tocar no token real
const ctx = await browser.newContext({ timezoneId: 'America/Los_Angeles', locale: 'en-US' })    // fuso e idioma
await page.emulateMedia({ media: 'print' })                                                     // impressão
```

- Tire a interceptação depois do caso (`page.unroute('**/api/x')`, `setOffline(false)`) e confira
  que a tela volta ao normal: isso também é um caso.
- **CLI, job e testes:** `TZ=Pacific/Kiritimati <cmd>` (fuso extremo), `faketime '2026-12-31 23:59:50'
  <cmd>`, `freezegun` (Python) e `jest.useFakeTimers().setSystemTime(...)` (JavaScript). No Windows,
  `TZ` não vale para todo runtime: confira na saída a hora que o programa leu.
- **Registre a técnica na evidência** (ex.: "route.fulfill 500 em /api/x", "TZ=Pacific/Kiritimati"):
  sem isso, o print de uma falha simulada parece falha real.
- Não injete falha pelo `xhr-spy.js` na aba do usuário: o espião só observa.

---

## 4. Prova

### 4.1 Rede

Para cada ação: `__qa.limpar()` → ação → `await __qa.esperarRede(...)` → `__qa.resumo()`.

Confira e registre:

- **Quantas** chamadas saíram. Zero chamada depois de "salvar" = no-op silencioso — **antes de
  concluir no-op, confira WebSocket e SSE** (`__qa.resumo()` inclui as linhas `WS` e `SSE` com os
  quadros enviados e recebidos; `__qa.quadros('<trecho>')` lista os quadros): a ação pode ter saído
  por um socket já aberto. Duas escritas iguais = possível duplo envio (confirme no banco, seção 4.2).
- Método, URL, **status**, `ms`.
- **Corpo enviado × o que a tela mostra.** Divergência aqui é defeito de estado (a tela renderiza
  de uma fonte e o envio sai de outra).
- **Corpo recebido**: o que o servidor devolveu, o id criado, mensagens de erro e se a tela as
  mostrou.
- Semântica do código HTTP: erro de validação devolvido como 401 pode derrubar a sessão do usuário
  pelo interceptador de autenticação.

Salve em `rede/NN-<chamada>.json` (mesmo `NN` do print daquele momento):

- extensão: devolva `__qa.exportar('<trecho>')` pelo `javascript_tool` e grave com a ferramenta de
  escrita de arquivo;
- Playwright: `browser_evaluate` ou `browser_network_request` com `filename`.

`read_network_requests` (extensão) mostra método/URL/status sem o corpo: serve para confirmar, o
espião serve para provar.

### 4.2 Banco, somente leitura

- Só `SELECT` (ou equivalente). Credencial lida da configuração do projeto **na hora**, nunca
  copiada para arquivo, nota, chat ou linha de comando registrada.
- Confirme a base antes da primeira consulta (seção 0). Códigos de registro podem **repetir entre
  ambientes**: diga sempre o ambiente junto do código.
- Trave a sessão em leitura quando o banco permitir:

  | Banco | Como |
  |---|---|
  | PostgreSQL | `PGOPTIONS='-c default_transaction_read_only=on' psql ...` |
  | MySQL/MariaDB | `START TRANSACTION READ ONLY;` antes das consultas |
  | SQLite | `sqlite3 -readonly arquivo.db` |
  | SQL Server | não há trava de sessão confiável: use login de leitura se existir; senão, só `SELECT` revisado antes de rodar |
  | MongoDB | só `find`/`aggregate` sem `$out`/`$merge` |

- Consulte **o que foi gravado e o que não deveria ter mudado**. Tire um retrato dos campos
  vizinhos **antes** da ação e compare depois: um "Salvar" sem alteração que apaga um campo que a
  tela nem carregou só aparece assim.
- Duplicata: conte as linhas do mesmo dono/chave. Órfão: procure filhos sem pai depois de excluir.
  Exclusão lógica: confira a coluna de "excluído" além da contagem.
- **Valide a própria consulta** com um registro conhecido antes de confiar num número: junção que
  ignora o tipo/módulo da tabela polimórfica conta linhas de outras entidades.
- Salve a consulta e o resultado (com dado pessoal mascarado) em
  `evidencias/NN-banco-<o-que-mostra>.txt` e ligue ao caso.

### 4.3 Efeitos a jusante

Abra o que a ação gerou e confira o **conteúdo**, não só a existência:

- listagem, contadores, KPIs e badges **sem recarregar** (e depois de recarregar);
- trilha de auditoria/atividades (autor, horário, texto);
- notificação e e-mail: na auditoria de envio da aplicação e, se autorizado, na caixa de teste
  (peça ao usuário para conferir a caixa quando você não tem acesso);
- documento gerado (abra o PDF/planilha), registro derivado (pedido, contrato, fatura), integração
  externa só com autorização registrada.

### 4.4 Tempo e console

- Anote toda requisição acima de 3 s e todo congelamento de aba, com o número.
- Leia o console filtrando por padrão (`error|warn|exception`). Separe ruído de extensão do
  navegador (stack em `chrome-extension://`) de erro da aplicação.
- Log do servidor, quando acessível, completa o diagnóstico de 4xx/5xx.

---

## 5. Evidências

### 5.1 Print de absolutamente tudo

Cada tela, cada estado (vazio, carregando, erro, sucesso), cada modal, cada toast, cada menu
aberto, cada tooltip de botão desabilitado, cada erro, e o **antes e depois** de toda correção. Um
passo testado sem print é um passo que não dá para mostrar a ninguém.

### 5.2 Nome dos arquivos

```text
evidencias/NN-o-que-mostra[-ANTES|-CORRIGIDO|-RETESTE][-circulado].png
rede/NN-<chamada>.json
evidencias/NN-banco-<o-que-mostra>.txt
```

- `NN` sequencial na rodada (dois dígitos; três se passar de 99). O **mesmo `NN`** agrupa print,
  payload e consulta do mesmo momento.
- `-ANTES`: estado com o defeito. `-CORRIGIDO`: o mesmo ponto depois da correção. `-RETESTE`:
  reteste de pendência ou de correção feita por outra pessoa (o resultado vai na nota e no ledger).
  `-circulado`: cópia anotada; o cru fica guardado ao lado.
- Kebab-case, sem acento e sem espaço: o nome passa por terminal, HTML e PDF.
- Nomeie com `-ANTES` desde a primeira captura de um achado: o relatório final precisa do par.

### 5.3 Nitidez e legibilidade

- Print de tela inteira larga fica ilegível numa página A4. Faça **um print de contexto** e **um de
  detalhe** (`zoom` com `region` na extensão, `target` no Playwright).
- Texto pequeno de modal: ampliar com `zoom` da ferramenta. Se ampliar via CSS (`el.style.zoom`),
  diga na legenda e nunca use esse print como evidência de layout.
- Registre na nota `innerWidth`, `devicePixelRatio` e a largura do print: layout responsivo muda o
  que aparece, e a anotação precisa do fator.

### 5.4 Circular o problema (`scripts/circular.py`)

Todo print de achado sai com **caixa vermelha numerada** no ponto exato do problema; o print
corrigido repete a caixa em **verde** no mesmo lugar, para antes e depois se lerem lado a lado.

1. Não role a página entre o print e a medição. Tire o print e meça no **mesmo lote**:

   ```js
   (() => {
     const marca = (sel, n, texto) => {
       const el = [...document.querySelectorAll(sel)].find((e) => {
         const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0;
       });
       if (!el) return null;
       const r = el.getBoundingClientRect();
       return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), n, texto };
     };
     return JSON.stringify({ largura_css: innerWidth, marcas: [
       marca('[data-testid="<alvo>"]', 1, '<o que esta errado, curto>')
     ].filter(Boolean) });
   })()
   ```

   `getBoundingClientRect` é relativo ao viewport, que é o que o print de viewport mostra. Em print
   de página inteira, some `scrollY` ao `y` (ou use `--deslocamento 0,<scrollY>`). Grave o resultado
   no mapa `<rodada>/evidencias/marcas.json`, sob a chave igual ao nome do print
   (`{"07-cnpj-vazio-aceito-ANTES.png": <resultado>, "07-cnpj-vazio-aceito-CORRIGIDO.png": <medida do DEPOIS>}`);
   o mesmo arquivo serve ao `provas.py`.
2. Rode (confira `python scripts/circular.py --help` se a interface mudar):

   ```bash
   python scripts/circular.py "$R/evidencias/07-cnpj-vazio-aceito-ANTES.png" --marcas "$R/evidencias/marcas.json"
   python scripts/circular.py "$R/evidencias/07-cnpj-vazio-aceito-CORRIGIDO.png" --marcas "$R/evidencias/marcas.json" --cor verde
   ```

   A saída é `<nome>-circulado.png`, sem tocar no cru; a entrada do mapa sai do nome do print (ou de
   `--chave`). Sem `largura_css` no mapa a escala sai errada. Nunca salve o mapa na raiz do projeto. A
   forma posicional antiga (`<entrada> <saida> '<marcas-json>' <innerWidth> [cor]`) ainda funciona.

3. **Abra o circulado e confira** que a caixa está no lugar. Caixa deslocada = medição de outro
   momento (rolagem, modal animando, cópia oculta): meça de novo.
4. Guarde o cru e o `-circulado`. O relatório usa o circulado.

### 5.5 Ligar ao ledger e à nota

- Cada caso recebe em `evidencias[]` os caminhos relativos: print(s), `rede/*.json`,
  `evidencias/*-banco-*.txt`.
- Cada print tem uma linha na nota da fase: o que mostra, URL, papel/sessão, ambiente, passo.
- `passou` e `falhou` **exigem** evidência; `falhou` exige `defeito_id`.
- Grave a cada caso, nunca no fim: dez prints sem registro viram contexto perdido.

---

## 6. Anti-falso-positivo

Antes de chamar de bug, **descarte a ferramenta e o ambiente**. Em rodadas reais, vários "bugs"
caíram por isso — e um relatório com achado falso custa a confiança dos verdadeiros.

### 6.1 Sintoma → causa a descartar → como

| Sintoma | Descarte primeiro | Como |
|---|---|---|
| "Botão não faz nada" | clique fora do alvo (escala, janela que mudou, overlay), aba em segundo plano | `elementFromPoint` no centro, clique por `ref`, `visibilityState`, espião (zero chamada?), validação inline |
| "Valor não salvou" | preenchimento que não passou pelo `onChange` | refaça com clique + digitação; confira o corpo enviado |
| "Requisição duplicada" | espião instalado duas vezes, modo estrito de dev, duplo clique da automação | marca do espião; **conte no banco** |
| "Nunca respondeu" | leitura antes do tempo | `esperarRede`; compare tempo esperado × tempo do evento |
| "Não apareceu mensagem" | observador instalado depois do clique ou com filtro | instale antes, sem filtro; print em até 2 s; procure validação inline |
| "Mostra dados/permissões de outro usuário" | sessões misturadas no mesmo navegador; permissão sem novo login | confira a identidade da aba; peça novo login |
| "Erro inesperado" na primeira carga | servidor reiniciando | recarregue e repita |
| "Horário errado" | fuso do ambiente (servidor grava hora local, tela assume UTC) | compare valor cru do banco e fuso do servidor |
| "A regra sumiu" | removida de propósito | histórico (`git log -S`), changelog, decisão registrada; confira o código **da branch testada** |
| "Está corrigido" (alguém disse) | correção que não chegou à branch/ambiente testado | confira o código e o build em uso, não o relato |
| Medida igual para entradas diferentes | medição quebrada | prove que a entrada mudou (`innerWidth`, estilo computado) |
| Número do banco não bate | consulta errada (junção, exclusão lógica, filtro de tenant) | valide a consulta com um registro conhecido |
| "Aba vazia" | dado ainda carregando, texto recortado na leitura | espere a chamada da aba; screenshot antes de concluir |
| "Registro não existe" | ambiente errado (códigos repetem entre ambientes) | confirme o ambiente da sessão e do banco |

### 6.2 Reproduza por outro caminho

Repita com **outro meio**: outra ferramenta (extensão × Playwright), API direta, outro registro,
outro papel, ou peça ao usuário para fazer à mão. Se o "bug" sumir, ele era da ferramenta.

### 6.3 Verificação adversarial

Para cada defeito, antes de reportar:

1. Escreva o **melhor argumento de que não é bug** (ferramenta, ambiente, regra de negócio,
   comportamento especificado, decisão registrada) e tente prová-lo.
2. Pergunte **"se a pessoa acreditar nisto e agir, onde ela vai parar?"**. Frase verdadeira mas
   incompleta ("acontece ao editar", sem dizer que só num dos três ramos) manda consertar metade;
   frase mal atribuída ("veio no seu commit") manda procurar no lugar errado.
3. Descreva o **sintoma como quem usou a tela**; arquivo e linha vão no registro técnico.
4. Defeito crítico ou alto: considere céticos em paralelo com ordem de **refutar** (ver
   `references/multiagente.md`).

### 6.4 Retratação

Achado que caiu vira `retratado` no caso (e `tipo: retratado` no defeito, se já existia), com
**o que enganou** e **como foi desfeito**. Corrija em todo lugar onde ele foi escrito (nota,
relatório, mensagem). A retratação fica no relatório: ela vale tanto quanto o achado, porque ensina
o que a próxima rodada deve descartar.

Quando o achado depende de **onde** na tela, mande o print junto desde a primeira vez: texto sozinho
gera ambiguidade que um print resolve em um minuto.

---

## 7. Dados de teste

- **Crie o próprio dado.** Nunca use nem altere registro de outra pessoa. Um registro novo por
  caminho/bifurcação: não reaproveite um que já passou por outro caminho.
- **Dado real e conferido.** Documento de empresa (ex.: CNPJ, VAT): real, público, pesquisado e
  **conferido no banco** se já existe — documento inventado pode colidir com o de alguém ou
  esconder uma validação. Dado de **pessoa física**: nunca dado real de terceiro; use geradores de
  teste válidos ou o seed do projeto.
- **E-mail**: caixa de teste com `+tag` (`nome+qa-<rodada>-<caso>@dominio`) ou caixa descartável,
  só se o PERFIL/rodada autorizar envio real. Registre cada envio.
- **Nome identificável**: prefixo como `QA <AAAA-MM-DD> <caso>` para achar e limpar depois.
- **Valores-limite da regra real** (ex.: 50 × 51 quando o mínimo é 51), lidos do código/regra.
- **Sujeira**: tudo que o teste criou ou alterou, em qualquer ambiente, vai para `sujeira[]` no
  ledger com id, ambiente, estado final e como limpar — inclusive dado alterado **para o teste
  poder passar** (ex.: preço ajustado para destravar uma etapa).
- **Limpeza só pelo caminho de negócio** (excluir/cancelar pela aplicação). Nada de `DELETE` ou
  `UPDATE` direto sem pedido explícito. Se desfazer pela aplicação for impossível ou arriscar
  deixar o registro inconsistente, deixe e registre o porquê.
- Ação com efeito fora do sistema (e-mail para pessoa real, cobrança, ambiente provisionado num
  terceiro) **só com autorização registrada**. Sem ela, marque aquela ação e **siga com o resto**:
  nunca pare a rodada inteira por causa de uma ação.

---

## 8. Quando não dá para executar

O caso não fica `pendente` e não vira `passou` por substituição. Escolha o status certo e
justifique:

| Status | Quando | A justificativa diz |
|---|---|---|
| `bloqueado` | impedimento durante a rodada: servidor fora, ambiente caído, dado pré-requisito impossível de criar | o que bloqueou, quando, e o que destrava |
| `nao-validado` | daria para testar, mas não foi feito na tela real: falta papel/usuário, segundo usuário logado, efeito externo não autorizado, só houve leitura de código | **qual** usuário/papel/permissão/autorização falta e **até onde** foi executado (ex.: "falta autorização para e-mail real; testado até a notificação ser criada") |
| `nao-aplicavel` | o item não se aplica a este alvo | por que não se aplica |

- "Não testei" sem motivo não existe. "Falta o papel X" é acionável; "não testei" não é.
- Peça o que falta de uma vez, com o papel e a aba (ex.: "logue como aprovador na janela 2; vou
  testar aprovar e recusar").
- Itens `nao-validado` entram no relatório numa seção própria, com o que seria necessário.

---

## 9. Cartão por caso

```text
ANTES      identidade da aba e ambiente conferidos · espião e observador ativos · __qa.limpar()
           · retrato do banco do que pode mudar · print -ANTES (se for achado)
AÇÃO       elemento visível e no topo · clique/digitação real · sem segundo clique durante a requisição
PROVA      esperarRede · resumo + corpo enviado e recebido · toast/validação inline · print em até 2 s
           · banco: o que gravou e o que não devia mudar · efeito a jusante aberto e lido
DESCARTE   se falhou: outro caminho, ferramenta descartada, melhor argumento contra
REGISTRO   ledger (status, evidencias[], defeito_id ou justificativa) · nota da fase · sujeira
```

---

## 10. Comandos de referência e códigos de saída

Saiu do `SKILL.md` §6 para caber no limite de linhas dele; as regras continuam lá. Python 3.9+:
`python`, `python3` ou `py -3` (use o que existir; os exemplos usam `python`). Rode na raiz do
projeto testado; cada script tem `--help` em português, e o `--help` manda quando divergir daqui.

**PowerShell:** `$QA = "$HOME\.claude\skills\qa-total"`, `$R = ".qa/$(Get-Date -Format yyyy-MM-dd)-clientes"`
e um comando por linha (sem `\`); no PowerShell 5.1, rode antes `$env:PYTHONIOENCODING='utf-8'` e
`[Console]::OutputEncoding=[Text.Encoding]::UTF8`.

### 10.1 Ledger (`cobertura.py`)

```bash
QA="$HOME/.claude/skills/qa-total"; R=".qa/$(date +%F)-clientes"    # QA: ou a pasta base mostrada ao carregar a skill
python "$QA/scripts/cobertura.py" init "$R" --alvo "Clientes: listagem e cadastro" --tipo-projeto front-web --inicio agora \
  --perfil .qa/PERFIL.md --ambiente "localhost:3000 -> API dev -> banco dev" --autorizacao "pedido de QA: corrigir defeito claro na hora (usuario, 2026-09-30)"
# mais de um tipo: repita --tipo-projeto (ex.: full-stack e llm); revisão ou auditoria: --modo revisao
# reteste ("dei pull"): rodada nova com init "$R" --modo reteste --reteste-de <rodada-original> [--defeito D-NNN]
python "$QA/scripts/cobertura.py" rodada "$R" --ambiente "localhost:3000 -> API dev -> banco dev" \
  --ambiente-confirmado "host da API lido no espiao: localhost:7112|agora"   # fase 1, depois de medir
python "$QA/scripts/cobertura.py" rodada "$R" --git "front|develop|a1b2c3d" --baseline "typecheck|npx tsc --noEmit|310|310 erros TS, nenhum novo"
python "$QA/scripts/cobertura.py" rodada "$R" --contagem "rota|router x menu|14|14"   # fase 3: uma por modo
python "$QA/scripts/cobertura.py" add-item "$R" --id "elemento:/clientes#salvar" --titulo "Botao Salvar" --pai "tela:/clientes" --origem "src/app/clientes/page.tsx:120"
python "$QA/scripts/cobertura.py" add-caso "$R" --item "elemento:/clientes#salvar" --tecnica particao --dimensao acerto \
  --titulo "[EL-BTN-01] Salvar com dados validos" --esperado "201 e uma linha nova" --oraculo "service:42"   # C-0001
python "$QA/scripts/cobertura.py" add-caso "$R" --item "elemento:/clientes#salvar" --tecnica particao --dimensao erro \
  --titulo "[EL-TXT-03] Salvar com CNPJ vazio" --esperado "bloqueia sem requisicao" --oraculo "service:42"   # C-0002
python "$QA/scripts/cobertura.py" add-caso "$R" --item "tela:/clientes" --criar-item --tecnica rbac --dimensao bloqueio --papel aprovador \
  --titulo "[DM-AUT-01] Aprovar como aprovador" --esperado "status Aprovado" --oraculo "spec"   # C-0003
python "$QA/scripts/cobertura.py" set "$R" C-0001 --status passou --obtido "201, 1 linha" --evidencia evidencias/03-salvar-ok.png --evidencia rede/03-post-cliente.json
python "$QA/scripts/cobertura.py" add-defeito "$R" --titulo "Salvar envia CNPJ vazio" --severidade alto --onde "src/app/clientes/form.tsx:88" \
  --antes evidencias/07-cnpj-ANTES-circulado.png --caso C-0002
python "$QA/scripts/cobertura.py" set "$R" C-0002 --status falhou --defeito D-001 --evidencia evidencias/07-cnpj-ANTES-circulado.png
python "$QA/scripts/cobertura.py" set "$R" C-0003 --status nao-validado --justificativa "falta o papel aprovador logado; executado ate a solicitacao ser criada"
python "$QA/scripts/cobertura.py" add-sujeira "$R" --o-que "cliente de teste CLI-TESTE-01 criado" --ambiente dev --caso C-0001 \
  --estado-final "ficou: cliente de teste no dev" --como-desfazer "excluir pela tela de clientes"
python "$QA/scripts/cobertura.py" merge "$R" "$R/parciais/inventario-api.json"   # lote ou agentes; listar --status pendente | --itens-sem-caso; validar
python "$QA/scripts/cobertura.py" reconciliar "$R" --elementos "$R/rede/elementos.json"   # fase 3, só com UI (sem UI: "nao se aplica", saida 0)
python "$QA/scripts/cobertura.py" rodada "$R" --critica "passada=1;novos_itens=0;novos_casos=3;origem=lente codigo"   # fase 8
python "$QA/scripts/cobertura.py" gate "$R" --so-cobertura; python "$QA/scripts/cobertura.py" secoes "$R"   # no meio da rodada
python "$QA/scripts/cobertura.py" rodada "$R" --fim agora; python "$QA/scripts/cobertura.py" gate "$R"      # fechar: precisa sair 0
python "$QA/scripts/cobertura.py" fechar "$R"                   # depois da fase 11: gate final + nota 10-aprender
```

### 10.2 Diff, provas, PDF e aprendizado

```bash
python "$QA/scripts/escopo_diff.py" --base origin/develop --prefixo-api api/v1 \
  --md "$R/notas/02-escopo-diff.md" --json "$R/rede/escopo-diff.json" --parcial "$R/parciais/escopo-diff.json"
python "$QA/scripts/escopo_diff.py" --base origin/develop --incluir-working --prefixo-api api/v1 --ledger "$R" --falhar-se-descoberto  # gate do modo PR (o cobertura.py gate roda o mesmo)
python "$QA/scripts/escopo_diff.py" --tudo --so-inventario --prefixo-api api/v1 --ledger "$R" --falhar-se-descoberto  # fase 3
python "$QA/scripts/escopo_diff.py" --tudo --prefixo-api api/v1 --ledger "$R" --falhar-se-descoberto    # fases 8 e 9
python "$QA/scripts/circular.py" "$R/evidencias/07-cnpj-ANTES.png" --marcas "$R/evidencias/marcas.json"   # vermelho; -CORRIGIDO com --cor verde
python "$QA/scripts/provas.py" gerar "$R" --conferir                    # relatorio/provas.pdf do ledger
python "$QA/scripts/gerar_pdf.py" "$R/relatorio/relatorio.html"          # ou um .md; -o saida.pdf
python "$QA/scripts/aprender.py" licao --lote "$R/notas/licoes.json"; python "$QA/scripts/aprender.py" validar
```

- Marcas do `circular.py`: §5.4 e `references/provas-antes-depois.md` §4. Em página inteira,
  `--deslocamento 0,<scrollY>`.
- `gerar_pdf.py` e `provas.py` imprimem headless com perfil temporário, sem tocar na sessão logada.
- `segredos.py`, `fuzz_valores.py`, `visual_diff.py`, `painel.py`, `mensagens.py` e `entregas.py`
  têm o comando na referência do módulo (`modulos-avancados.md`, `modulos-opcionais.md`,
  `comunicacao-e-painel.md`, `entregas-por-branch.md`) e no `--help`.

### 10.3 Códigos de saída

| Código | Significado |
|---|---|
| 0 | ok |
| 1 | reprovou, achou ou ficou descoberto. No `escopo_diff`, também arquivo de linguagem sem suporte sem `--aceitar-raio-incompleto`; no `cobertura.py fechar`, gate final, entregáveis, nota `10-aprender.md` incompletos ou `aprender.py validar` sem sair 0; em `painel`, `provas`, `gerar_pdf`, `mensagens` e `cobertura relatorio`, segredo mascarado na saída; em `mensagens`, anexo citado que não existe; no `gerar_pdf`, também placeholder `{{` sobrando |
| 2 | uso ou estado inválido. No `cobertura.py`: `passou` sem evidência, `falhou` sem defeito, status sem justificativa ou com justificativa genérica, evidência em texto livre ou URL, segredo em campo, esquema inválido, conflito de `merge` sem `--estrategia`, `rodada --modo` trocando para ou de reteste num ledger com casos, `reconciliar` sem `--elementos` em rodada com UI |
| 3 | `cobertura`: trava ou ledger em uso; `aprender`: outra gravação em andamento; `provas` e `gerar_pdf`: sem navegador (o HTML fica); `circular`, `entregas` e `visual_diff`: ambiente ou Pillow ausente |
| 4 | `provas` e `gerar_pdf`: falha na impressão; `aprender`: recusada por trava |
| 5 | `provas`: PyMuPDF (dependência exigida) ausente; `aprender`: lição duplicada |

Saída 3 do `cobertura` e do `aprender` é trava: espere a outra gravação e repita. Saída 3 dos demais é
ambiente: diga o que falta, nunca trate como reprovação do teste.
