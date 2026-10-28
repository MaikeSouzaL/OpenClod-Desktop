# Auditoria completa do harness Openclod — 27/10/2026

> Pedido: olhar pastas e arquivos, conferir se tudo foi realmente implementado, testar tela por tela,
> ferramenta por ferramenta, agente por agente, comparar com o Claude Code Desktop e melhorar o que desse.
> Regra seguida (PROMPT MESTRE): nada é dado como pronto sem teste reproduzível; o que não foi verificado
> aparece como não verificado.

Este arquivo é o resumo. O detalhe (tabelas requisito por requisito, bugs com reprodução, melhorias com
arquivo e critério de pronto) está em [`docs/audit/`](audit/): seis relatórios, ~5.800 linhas.

## 1. Veredito

- **O laço do agente funciona de verdade com um modelo real.** Primeira validação fora do provedor
  roteirizado: DeepSeek (`deepseek-flash`) executou 7 pedidos reais num projeto descartável — criar código
  e teste e rodar, editar, git, delegar a um subagente, criar um SVG pela skill, ler uma página web, gravar
  memória — com resultado conferido no disco. Custo ≈ US$ 0,07.
- **Base sólida:** 962 testes unitários passam; as ferramentas básicas (arquivos, shell, git, busca,
  navegador, documentos, imagens, OCR, áudio, memória, web, leitura do computador) passaram numa bateria
  de 105 chamadas reais; 15 roteiros E2E de interface passam.
- **Mas "feito e provado" ainda é cerca de um quarto do que os seus prompts pedem.** Dos 1.158 requisitos
  extraídos dos prompts dos módulos 01–30: ✅ 300 (26%) · 🟡 530 (46%) · ❌ 314 (27%) · ❓ 14 (1%).
  O que falta é sobretudo a camada de plataforma (CLI/headless, hooks completos, índice de código/LSP,
  git avançado, confiança de projeto, segurança por padrão), não o laço básico.
- **Contra o Claude Code** (670 capacidades catalogadas de fontes oficiais): ✅ 88 · 🟡 296 · ❌ 239 ·
  ➕ 46 (onde o Openclod faz algo que o Claude Code não faz: ditado local, grafo de memória, Computer Use
  nativo no Windows, delegação a outros agentes de código, etc.).
- **Telas vs. Claude Desktop** (96 itens): ✅ 22 · 🟡 47 · ❌ 20 · ❓ 7, com 35 bugs de interface
  (5 P0, 19 P1, 11 P2).

## 2. O que foi executado de verdade (e como repetir)

| Camada | Resultado | Como repetir |
|---|---|---|
| Typecheck + build | limpo | `npm run build` |
| Testes unitários | **139 arquivos, 1986 testes passam, 1 pulado, 1 falha passageira** (rodada de 27/10 às 14:00, depois da pré-carga das ferramentas que o usuário nomeia; typecheck dos dois projetos limpo. A falha foi `tests/mascot-render.test.ts` > "stays still while paused", um teste de renderização em navegador real que compara hashes de imagem e passou (7/8, 1 pulado) ao rodar sozinho; na rodada das 12:49 foram 133 arquivos e 1885 testes, 0 falhas, e na das 11:25 um teste de `tests/fixes.test.ts` falhou porque outra sessão editava `src/main/settings.ts` no meio dela). Na rodada das 09:30: 118 arquivos, 1687 passam, 0 falham (eram 941 no início da auditoria; depois da frente de memória e economia de tokens; os 3 testes que checavam o desenho antigo do prompt do sistema foram reescritos para o novo: memória e servidores MCP chegam no contexto do turno). Na rodada anterior eram 105 arquivos, 1532 passando e 3 falhando por isso | `npx vitest run` |
| Bateria de ferramentas reais | **105 de 105 passam** (na 1ª rodada falharam 2: `git_status` escondia arquivos novos — corrigido — e um erro do meu próprio teste) | `npx esbuild scripts/harness-battery.ts --bundle --platform=node --format=cjs --outfile=.qa/harness-battery.cjs --external:sharp --external:playwright --external:@lydell/node-pty && node .qa/harness-battery.cjs --net --ui` |
| E2E de interface (Electron, perfil descartável) | 15 de 15 passaram na primeira rodada (ainda com o provedor Scripted, removido depois). Depois: os 9 scripts que o usavam foram convertidos para **modelo real** e cada um foi executado e passou; `ui-drawings` (9 checagens) e `ui-mascot` (6) são novos. Os 7 que nunca usaram o Scripted (backup, diagnóstico, memória, notificações, slides, updater, voz) também foram rodados contra o build final e passaram. | `node scripts/ui-<nome>.cjs` |
| Modelo real (DeepSeek) | `ui-real-model`: 7/7 e depois 8/8 na regressão; após a conversão rodei só 3 dos 8 prompts (código, edição, memória), todos passaram | `node scripts/ui-real-model.cjs --from "%APPDATA%\Openclod Desktop" --provider deepseek` |
| Regressões desta rodada | fluxos de sessão (aprovação, troca no meio do turno, CSS, abertura) | `node scripts/ui-session-flows.cjs` |
| Auditoria de requisitos | 1.158 requisitos × código + testes | `docs/audit/modulos-*.md` |
| Auditoria de telas | 107 capturas × componentes | `docs/audit/telas-vs-claude-desktop.md` |
| Catálogo Claude Code | 670 itens com fonte | `docs/audit/claude-code-capacidades.md` |

A bateria cobre: `write/read/edit/patch/delete`, `list_dir`, `glob`, `grep`, `run_command` (timeout, exit code,
stderr, cwd), `start/read/stop_process`, `list_ports`, `git_*`, `code_intelligence`, `quality_*`, `document_extract`
(md/csv/html), `image_inspect/edit/ocr/generate`, `media_transcribe`, plano, skills, memória (wiki, legado,
handoff), `ask_user`, `report_limitation`, `fetch_url` (inclusive bloqueio de metadados), `web_search`,
`download_file`, `web_research`, 13 ferramentas de navegador (Playwright) e 5 de leitura do computador.

**Não reexecutado hoje (declaro como não verificado):** ações de escrita do Computer Use (mouse/teclado — a
matriz de 24/10 com 46/50 foi lida, não repetida), extensão do Chrome **no Chrome do usuário** (a v0.2.0 foi testada
num Chrome isolado, com o host nativo real; a instalação no Chrome dele depende de dois cliques dele), login OAuth real, WSL/SSH/nuvem,
instalador, execução com Anthropic/OpenAI/Kimi/Qwen, `external_agent` com Claude Code/Codex reais.

## 3. Corrigido nesta rodada (cada item com prova)

| # | Problema | Correção | Prova |
|---|---|---|---|
| 1 | **A janela levava 55–70 s para abrir** (perfil novo): os MCPs importados eram iniciados um por um antes de criar a janela. Em perfis com MCP lento é o mesmo travamento a cada partida. | `orchestrator.ts`: MCP sobe em segundo plano, em paralelo, serializado; aparece como "iniciando" | medido: 55–70 s → **3 s**; scripts E2E de 45 s → 6–13 s |
| 2 | **Capturas de tela das ferramentas nunca chegavam ao modelo** (`computer_screenshot`, `browser_screenshot`) nos adaptadores OpenAI-compatível e Anthropic. | `providers/openai.ts` (mensagem de usuário com as imagens após as `tool`) e `anthropic.ts` (bloco de imagem dentro do `tool_result`), só se o modelo tem visão | `tests/tool-images.test.ts` (4) |
| 3 | **Edições simultâneas no mesmo arquivo se perdiam** (40 → só 1 aplicada), `write_file` apagava a edição do usuário feita depois da leitura, arquivo Windows-1252 era corrompido, patch LF em arquivo CRLF misturava quebras. | `tools/fs.ts` + `util/file-lock.ts`: trava por arquivo, recusa se mudou desde a leitura, recusa não-UTF-8, preserva CRLF | `tests/fs-safety.test.ts` (7; **4 falham no código antigo**) |
| 4 | **Salvar a sessão falhava sob concorrência** (26 de 30 rejeitavam) e o diário de eventos chegou a **155 MB** (96% eram deltas de texto). | `session/store.ts`: gravação em fila com temporário único; diário sem deltas e com teto de 10 MB; `flush` com tratamento de erro | `tests/session-store.test.ts` (+2) |
| 5 | **`git_checkout` podia destruir trabalho local** (`-f`, `a.txt` como "branch"); `git_status` escondia arquivos novos atrás de `src/`. | validação do nome + `git switch`; `--untracked-files=all` | `tests/git-tools.test.ts` (3) |
| 6 | **Backup impossível nesta máquina** (diário de 155 MB e qualquer `.env` numa skill abortavam tudo). | `backup/service.ts`: pula diários e segredos e informa `skipped` | `tests/backup.test.ts` (+1) |
| 7 | **Cancelar contava como falha** (notificação "tarefa falhou", métrica) e o **resto do lote de ferramentas rodava depois de "Parar"**. | `runner.ts`/`types.ts`: `turn_end.cancelled`; lote interrompido; Atividade, métricas e notificações respeitam | `tests/runner.test.ts` (+3) |
| 8 | **Trocar modelo/modo/esforço durante um turno abortava o turno.** | `orchestrator.ts`: salva já, aplica quando o turno termina | `ui-session-flows.cjs` |
| 9 | **Aprovação pendente sumia ao trocar de sessão** (o agente travava 5 min e era negado); `sessions.get` devolvia estado velho. | `sessions:get` devolve aprovações pendentes e estado vivo; `App.tsx` restaura | `ui-session-flows.cjs` (1 → 0 → 1) |
| 10 | **Preview do estúdio de artefatos espremido em 110 px** (regra CSS duplicada). | `styles.css`: miniatura só dentro do cartão | `ui-session-flows.cjs` (560 px) |
| 11 | **Compactação perdia o histórico além de 60 mil caracteres** (cortava o *início* do que seria descartado). | `compaction.ts`: resumo progressivo em blocos de 50 mil, sem perder o resumo anterior se um bloco falha | `tests/compaction.test.ts` (+2) |
| 12 | 4 roteiros E2E estavam obsoletos desde a carga preguiçosa de ferramentas (documents, images, plugins, media-transcribe). | passam a chamar `tool_load` como um modelo real | rodados: passam |
| 13 | **DeepSeek como provedor padrão** (pedido seu). | `defaultProviderId = deepseek` no perfil real (pelo próprio app); backup `config/settings.json.bak-2026-10-26-default-deepseek` | lido de volta do app e do disco |
| 14 | Comentário em `settings.ts` dizia que comandos perigosos e segredos "ainda perguntam" no modo `unrestricted`; não perguntam. | comentário corrigido (comportamento mantido — ver decisões) | leitura de `permissions.ts` |

### 3.1 Segunda rodada (continuação, mesmo dia): trabalhar como o Claude no computador, no desktop e na web

| # | Problema | Correção | Prova |
|---|---|---|---|
| 15 | `run_command` guardava o **início** da saída e perdia o fim (a linha "3 falhas" de um teste longo), cortava acentos entre blocos, mostrava `não` como `n?o` (cmd.exe imprime em CP850), deixava o stdin aberto (REPLs travavam até o timeout) e levava 7 s para responder a um timeout de 1 s. | `util/output-capture.ts` (início + fim), `util/oem-decode.ts` (UTF-8 ou página OEM por linha), stdin fechado, resposta 1,5 s depois de matar a árvore | `tests/shell-capture.test.ts` (10), `echo ação` real |
| 16 | **Extensão do Chrome clicava em `<html>`** (primeiro elemento cujo texto contém o nome), digitava sem avisar frameworks (React) e "Enter" nunca enviava formulário. | `chrome-extension/page-tool.js`: resolvedor por nome acessível/papel, só elementos visíveis, melhor correspondência vence, `requestSubmit`, setter nativo, selects/checkbox/contenteditable, Tab, snapshot com papéis e links | `tests/chrome-page-tool.test.ts` (8, **Chrome real**) |
| 17 | Navegador (Playwright) não seguia aba aberta pela página (`target=_blank`, popup de login) e clicava no primeiro de vários alvos sem avisar. | `browser/layer.ts`: adota abas novas e a torna ativa; informa `N elementos casam` | `tests/browser-layer-live.test.ts` (2, Chrome real) |
| 18 | Computer Use: vários agentes disputavam o **mesmo mouse e teclado** sem fila; atalhos (Ctrl+S) não disparavam em apps clássicos pela rota padrão. | fila única de entrada (`computer/layer.ts`); atalhos com modificador vão como entrada global quando há janela alvo | `computer-queue`, `computer-shortcuts` + **bateria `--desktop`**: abre o próprio Bloco de Notas, lê a árvore, digita com acentos, Ctrl+S, confere o arquivo no disco |
| 19 | **Skills quase inertes**: só a contagem entrava no prompt; descrição YAML dobrada (`>`) virava um caractere; BOM/CRLF quebravam. Não havia skill de **animação**. | `agent/context.ts` lista nome + descrição e manda usar `use_skill` antes de agir; `skills/library.ts` entende `>`/`\|`/aspas/CRLF/BOM; nova skill `animation-master` com `check-animation.mjs` | `tests/skills.test.ts` (8) |
| 20 | Só o `CLAUDE.md` da pasta era lido. | pais até a raiz do repositório, `CLAUDE.local.md`, `@imports` dentro do projeto, limite de 40 mil caracteres | `tests/instructions-hierarchy.test.ts` (4) |
| 21 | Segurança: *symlink* pendente criava arquivo fora do projeto; `git_commit add_all` levava `.env`/chaves; DOCX de 300 KB expandia para 300 MB; PDF com fontes embutidas voltava lixo como sucesso. | `WorkspaceGuard` segue links; credenciais ficam fora do `add_all` (e são listadas); `unzipLimited` recusa antes de inflar; PDF ilegível vira erro com caminho de saída | `workspace-symlinks` (3), `git-tools` (+2), `document-extractor` (+3) |
| 22 | Provedor pago sem tarifa: custo aparece US$ 0 e o limite de custo nunca dispara (sem aviso). | aviso único no turno, exceto servidores locais | `tests/runner.test.ts` |
| 23 | `window.prompt()` não existe no Electron (credenciais de conectores, motivo de invalidar memória). | `renderer/lib/prompt.ts` (diálogo no app, Esc/Enter/clique fora, campo secreto) | `tests/prompt-dialog.test.ts` (3, Chrome real) |
| 24 | **Comandos personalizados** (`/nome`) não existiam. | `core/commands/library.ts`: `.claude/commands`, `.forja/commands` e pasta do usuário; `$ARGUMENTS`, `$1..$9`, namespaces; aparecem no menu "/" e expandem no envio | `tests/custom-commands.test.ts` (3) + `ui-session-flows.cjs` (menu, escolha, texto enviado ao modelo) |
| 25 | `sessions:get` devolvia mensagens e estado atrasados em relação ao que a interface acabara de mostrar. | devolve o instantâneo vivo do runner quando existe | `ui-session-flows.cjs` |

### 3.2 Terceira rodada: só modelos reais, desenhos na tela, a análise de uma sessão travada e a extensão do Chrome

| # | Problema / pedido | Correção | Prova |
|---|---|---|---|
| 26 | "Devemos sempre usar modelos reais": o provedor **Scripted/autoteste** (`kind: 'mock'`) existia no produto e nos testes. | Removido: `providers/mock.ts`, preset, tipo `kind`, listas e telas; `settings.json` antigo perde o provedor sozinho e o padrão volta a DeepSeek (settings v7). O dublê de teste fica só em `tests/support/scripted-provider.ts` (nunca no app). | `tests/fixes.test.ts` (+1: arquivo antigo migrado e persistido); scripts E2E convertidos para modelo real (ver §2) |
| 27 | Desenhos (SVG, HTML/canvas) saíam como texto de código. | `DrawingBlock`: o desenho aparece como imagem, com abas **Visualizar/Código**, copiar, baixar, tela cheia, fundo claro/escuro; SVG vira `<img>` (scripts não rodam), HTML/canvas em `iframe sandbox`; o card de `write_file` de `.svg/.html` mostra o mesmo desenho; prosa e desenho são separados para não piscar durante o streaming. | `tests/drawings.test.ts` + **`scripts/ui-drawings.cjs` com DeepSeek real**: casinha SVG desenhada como imagem (`naturalWidth > 0`), aba Código, tela cheia com Esc, `desenhos/sol.svg` animado salvo e mostrado no card (capturas em `Prints/desenhos-2026-10-27/`) |
| 28 | Sessão real travada por ~4 min validando uma animação (análise abaixo). `browser_open` falhava com "Chrome existente não conectado" e as `browser_*` ficavam todas inutilizáveis. | Em "Chrome existente" sem extensão, abre um **Chromium isolado** e avisa o modelo ("sem os logins nem as abas do usuário"); opção em Configurações → Navegador para exigir o Chrome do usuário. | `tests/browser-tabs.test.ts` (+1, +1 ajustado) |
| 29 | Modelo sem visão (DeepSeek) pedia captura atrás de captura e "descrevia" imagens que não recebeu. | O resultado diz que a imagem **não foi recebida**, proíbe deduzir o conteúdo e aponta `computer_snapshot`, `browser_snapshot`, `browser_read`, `image_ocr`. | `tests/runner.test.ts` |
| 30 | `run_command` com timeout sem nenhuma saída (ex.: `chrome --headless … \| findstr` segura o pipe) levava o modelo a repetir o mesmo comando por 180 s + 90 s. | O resultado explica a causa provável e as saídas (redirecionar para arquivo, `run_in_background`, timeout menor). | `tests/shell-capture.test.ts` (+1) |
| 31 | **Extensão do Chrome** simples demais (sem ícone, popup, aviso, parada; `browser_console` vazio no Chrome real). | **v0.2.0**: ícones, popup de status, aviso na página com botão **Parar** (+ atalho Alt+Shift+S, que cancela o turno no app), distintivo na barra, console e erros de rede, screenshot sem o aviso, `hello_ack` do app, *backoff*, cópia estável em `%APPDATA%`, host registrado também no Edge/Brave/Chromium, aviso de versão antiga, `.zip` (`npm run pack:chrome-extension`). Detalhes em `docs/CHROME-EXTENSION.md`. | `tests/chrome-extension*.test.ts` + `tests/chrome-bridge.test.ts` (17): **extensão real em Chrome real + host nativo real + ponte de teste** |
| 32 | **Bug achado pelo teste real:** `browser_screenshot` no Chrome do usuário sempre falhava ("exige `<all_urls>` ou `activeTab`"). | Manifesto passa a declarar `<all_urls>`. | `tests/chrome-extension.test.ts` (screenshot) |
| 33 | Validar uma animação sem enxergar imagens. | `check-animation.mjs --frames`: renderiza o `.svg`/`.html` num Chrome/Edge real (perfil temporário, sem pipe) **buscando o instante exato** (`setCurrentTime` + `getAnimations()`, por isso é reproduzível), mede a % de pixels que mudou e falha se a animação declarada não se mexe ou se o quadro vem em branco; a skill `animation-master` ensina a usá-lo. | `tests/skill-animation-frames.test.ts` (4, Chrome real): spinner SMIL mexe e volta a 0% em 1 s, CSS `@keyframes` em SVG e em HTML, animação parada vira erro, quadro vazio vira erro |
| 34 | **Mascote** do overlay: só piscava, sem reagir ao que o agente vive. | Novo desenho (cabeça branca, tela de vidro escura, olhos LED âmbar, orelhas com anel luminoso, como nas suas referências) e **14 humores** ligados à dificuldade real (`core/computer/mood.ts`): falhas seguidas, timeout (conta dobrado), comando sem resposta há 20/60/150 s, aprovação pendente, contexto cheio, instabilidade do provedor; ao fim do turno comemora ou entristece, e alívio depois de dificuldade. A pílula diz o motivo ("Tentando de novo: 2 falhas seguidas"). | `mascot-mood` (55), `mascot-render` (8, Chrome real, quadros de animação), `computer-overlay-html` + **`scripts/ui-mascot.cjs` com DeepSeek real**: calm → working → happy ("Pronto!"), depois confused → struggling → overwhelmed numa sequência real de 3 URLs inexistentes. Folha: `Prints/mascote-2026-10-27/humores.png` |
| 35 | Scripts E2E ainda dependiam do Scripted. | Os 9 scripts (`ui-documents/images/improve/media-transcribe/plugins/session-flows/tts/work/worktrees`) usam modelo real via `scripts/lib/e2e.cjs` (ou nenhum modelo, quando a tela não precisa); `ui-work` ganhou asserções de verdade (antes saía sempre 0). | Cada um executado e lido; ver o relatório do agente na §2 |
| 36 | Nota da Atividade da Revisão de melhorias levava o nome do projeto cru (chave/caminho pessoal). | `redactDiagnosticText(info.projectName, 120)` em `src/main/improvement.ts` | `tests/improvement-notify.test.ts` |
| 37 | **O harness trava depois que o usuário envia a mensagem** (o texto fica na caixa e nada acontece por minutos; reproduzido com os dados reais, `sessions:send` não retornava em 45 s e o processo principal ficava parado). | Causa medida: antes do primeiro turno de uma sessão, `ensureRunner` esperava copiar **todas as páginas da memória do projeto** (71 no projeto real; 2 chamadas HTTP por página) para o sidecar AI-Memory. Agora essa cópia roda em segundo plano, lembra o que já copiou (impressão digital do conteúdo, só a primeira vez é longa), para após 60 s e continua depois; o que for lento ao iniciar um turno (>1 s) é registrado no log ("iniciar turno: … levou N s"). | `tests/orchestrator-start-turn.test.ts` (4): **falha com o código antigo** (trava 20 s; sincronização que falha derrubava o turno) e passa com a correção; medição na cópia do perfil real: envio 2,5 s (antes: sem resposta), resposta do modelo 6 s depois |
| 38 | A caixa de mensagem só esvaziava depois que o processo principal respondia, parecendo travada sempre que iniciar o turno demorava. | Esvazia na hora (devolve o texto se a mensagem for recusada), mostra "pensando" imediatamente e avisa "Preparando a sessão…" após 4 s. | `scripts/ui-send-latency.cjs` (modelo real): caixa esvazia em 0,1 s, mensagem salva em 1,2 s |
| 39 | **Fechar o app travava** (a janela ficava aberta por mais de 20 s e precisou ser encerrada à força): o desligamento parava um servidor MCP por vez, sem limite. | Desligamento em paralelo com prazo de 4 s por parte; a janela some ao fechar; o processo sai em no máximo ~11 s mesmo que algo não obedeça. | medido: o app saiu 0,2 s depois de fechar a janela no perfil de teste (não reproduzi o travamento antigo de forma isolada) |
| 40 | **MCP como no Claude: diretório de conectores, ferramentas de primeira classe, OAuth, segredos no cofre** (o agente não conseguia usar o Jira; Configurações → MCP mostrava chaves em texto puro; os MCPs só existiam por `mcp_call`). | Diretório de **900 conectores** (875 do diretório do Claude + catálogo próprio) em Personalização → Conectores (busca, categorias, status, detalhe com ferramentas e permissão por ferramenta, conector personalizado, app OAuth próprio); ferramentas `mcp__servidor__ferramenta` com política por ferramenta e adiamento por `tool_search`; recursos/prompts/elicitação; robustez (um servidor travado não bloqueia os outros, reconexão, sessão e versões de protocolo, SSE, cancelamento/progresso, `mcp_reload`); OAuth tolerante (issuer com path, `resource_metadata`, `localhost`, client id próprio, porta fixa 38565, refresh/revogação); segredos no cofre com migração, máscara e backup; dicas de erro em pt-BR (caso Atlassian). **`ask` agora vale também no modo irrestrito** (as regras `approvalTools` nunca eram aplicadas). **Partida lenta, achada no primeiro reinício com os servidores reais do usuário:** `rea` apareceu como falho (`tools/list` com 274 ms, porque o `initialize` gastou 19,7 s dos 20 s) e `jira`/`appwrite-docs` deram timeout de 20 s. Agora o prazo de partida padrão é de 30 s (era 20 s; o Claude Code também espera 30 s), cada listagem tem pelo menos 10 s depois do handshake e um servidor que esgota o prazo na partida ganha uma segunda tentativa automática (não para login, queda ou comando ausente); o `main.log` mostra `MCP <nome>: pronto em N s`. **Visto no app real, no segundo reinício:** `rea` pronto em 6,6 s (185 ferramentas), `appwrite-docs` em 26,2 s (teria estourado os 20 s antigos), `jira` esgotou os 30 s, tentou de novo sozinho e subiu em 12,5 s (38 ferramentas). Seguem falhando por motivo externo: `appwrite-api` (o Appwrite responde 403 `general_resource_blocked`) e `mercadopago` (401, precisa de login). Ver `docs/CONECTORES.md`. | Sondagem dos 795 endpoints + **bateria pelo código real nos 900** (`docs/mcp/TESTE-CONECTORES-2026-10-27.md`): 113 conectam sem login, 492 com login de 1 clique pronto, 102 pedem client id próprio, 90 bloqueados pelo serviço; `scripts/ui-mcp-agent.cjs` (**modelo real + conector real**, 12 checagens); `scripts/ui-connectors.cjs` (77); ~370 testes novos. **N5 (entrar com a conta de cada serviço) não foi feito: exige o login do usuário** |
| 41 | **Leitura em voz alta lia o markdown cru e, ao clicar de novo, caía na voz do Windows** (o usuário ouvia `**`, crases e traços, coisas que a tela não mostra; o log tinha "Edge Neural TTS falhou: motor neural terminou com código 1" duas vezes, sem mensagem de erro). | `src/renderer/src/lib/speech.ts` (`speechText`) converte a resposta pelos mesmos tokens que a tela desenha (`marked`, mesmas opções): lê só o texto visível, sem `**`, crases, `#`, traços de lista nem endereços inteiros (link vira o texto, endereço solto vira o site); não lê bloco de código, desenho SVG nem imagem, mas lê uma resposta escrita para o cliente dentro de um bloco simples; tabela linha a linha; emoji e `·`/`→` viram pausa; no máximo 18 000 caracteres, cortando no fim de uma frase. O botão vira "Parar leitura" na hora (antes só quando o áudio ficava pronto) e o segundo clique para. No processo principal (`TtsService`) uma síntese substituída ou parada é **cancelada** (`cancelled`) em vez de cair na voz do Windows, e o fim tardio dela não apaga mais o processo da síntese nova: o "código 1" do log era o `taskkill` do segundo clique, não a voz neural quebrada (a síntese isolada funciona: 2,2 s). | `tests/speech-text.test.ts` (12) e `tests/tts-cancel.test.ts` (4; 3 falham com o código antigo, conferido desligando a correção); `scripts/ui-tts.cjs` com **modelo real + voz neural real em volume 0**, 12 checagens: tela formatada, botão vira "Parar" na hora, o motor recebeu o texto sem símbolos e só com palavras que estão na tela, o segundo clique para sem voz do Windows e sem falha no log, o botão segue em "Parar" enquanto o áudio toca. Capturas em `Prints/voz-2026-10-27/`. **Nenhuma pessoa ouviu o resultado:** o teste roda em volume 0 |
| 42 | **Áudio e vídeo anexados não viravam contexto** (só existia `media_transcribe`, que devolve o texto cru a cada chamada e não guarda nada; nenhum frame, folha de contato, texto da tela nem memória para outro modelo usar). | Ingestão interna, sem interface, no estilo do claude-real-video (MIT, portado): `resources/media/forja_media.py` no runtime embutido (PyAV, numpy, faster-whisper; sem ffmpeg nem Pillow) faz frames por mudança de cena com deduplicação em três canais, folhas de contato 3×3 e transcrição em paralelo; o OCR do Windows lê o texto dos frames num só processo; a memória do projeto recebe uma página-índice e partes de poucos minutos ligadas por links, com a fala e os frames na mesma linha do tempo. Anexos (ou caminhos escritos pelo usuário) são processados **antes** do primeiro chamado ao modelo (`SendOptions.prepare`, mostrado como atividade “processando mídia”); `media_ingest` e `media_view` para o resto. Prioridade abaixo do normal para não travar o app. Ver `docs/MIDIA.md`. | Motor real em vídeo sintético e em 2 vídeos reais (34 s vertical: 36 frames/4 folhas/pt 98,8% em 10,9 s; 5 min 33 s 1080p: 150 frames/17 folhas/93 trechos em 87,7 s) e em voz pt-BR do Windows; 49 testes novos (`media-ingest`, `media-memory`, `media-paths`, `media-ocr`, `runner-prepare`); `scripts/ui-media.cjs` com DeepSeek real: 18/18 (áudio antes do modelo, sessão nova responde pela memória, vídeo com fala + OCR). **Não feito:** vídeo por URL, quem fala, descrição das imagens por IA (modelo sem visão só recebe seleção + OCR), vídeo de celular com rotação testado só na função |
| 43 | **Memória em grafo e economia de tokens** (o pedido: qualquer LLM continua o trabalho buscando contexto na memória, o harness busca sozinho, MCPs/skills/agentes só quando precisam, e o mínimo de tokens). Medido antes: nas sessões reais, **2%** da entrada da 1ª chamada de cada turno e **9%** da chamada seguinte a `update_plan` vinham do cache (92% nas demais), porque o prompt do sistema carregava plano, briefing da wiki, recall e servidores MCP e mudava a cada turno; essas 8,7% das chamadas eram **50% dos tokens sem cache**. A memória real do maior projeto: 24 de 73 páginas eram hubs "Índice: <palavra>" (abre, falta, afzer…), 3 duráveis, nenhum link entre duráveis; a busca punha dois hubs na frente da página que responde. O painel Contexto mostrava números fixos. | Prompt do sistema **estático** + uma mensagem oculta `<contexto-do-turno>` por pedido (`turn-context.ts`); **pacote de memória** ranqueado por tipo/cobertura/recência com vizinhos por links (`pack.ts`), sem hubs, sem repetir o que já foi enviado, vazio para "ola"; hubs só para assunto durável (os antigos vão para `wiki/.archive`, cópias no índice apagadas); `memory_page write` liga páginas duráveis; `memory_recall`/`search`/`read` pelo mesmo ranking e lendo também o que só existe no índice; **cápsula de continuidade** por sessão gravada pelo app (`state-page.ts`) entregue a uma sessão nova; resumo do histórico quando **outro modelo assume** uma conversa longa (troca de modelo ou fallback por cota); sugestões de skills/agentes/ferramentas (`suggest.ts`) e `list_skills`/`list_agents` com `query`; painel Contexto com números **medidos**. Ver `docs/MEMORIA-E-TOKENS.md`. | A/B com DeepSeek real, mesmos prompts: 1ª chamada do turno **6% → 99%** em cache, após `update_plan` **1% → 100%**, tokens sem cache por chamada **15 333 → 2 285 (−85%)**, base de sessão nova 9 959 → 10 031; memória real 73 → 54 páginas, "como conectei o Jira no harness" de fora dos 8 primeiros para 1ª, "ola" 0 tokens; passagem de bastão (`scripts/ui-handoff.cjs`, deepseek-flash → deepseek-v4-pro): **4/4** testes ocultos em todas as 8 execuções (o build antigo também), mas sem chamar ferramenta de memória e com 5 chamadas/100 mil tokens contra 10/233 mil quando A não grava memória e há 8 sessões no meio; **sem memória o segundo modelo perguntou ao usuário e entregou 2/4**; painel Contexto medido 7% do provedor (`scripts/ui-context-meter.cjs`, 12 checagens); 76 testes novos em 9 arquivos. **Limites:** uma execução por cenário; o "outro LLM" é outro modelo DeepSeek (única chave); busca lexical; o piso de uma sessão nova **caiu de 12% a 15%** (mesma árvore, só a lista muda, DeepSeek V4.1 flash: 9 401 → 8 274 tokens na 1ª chamada; DeepSeek pela API: 10 553 → 8 974): nove ferramentas pouco usadas (`memory_brief`/`memory_search`/`memory_handoff`, `list_skills`, `mcp_servers`/`mcp_catalog`/`mcp_call`, `list_agents`/`task`) saíram da lista de toda chamada e carregam por `tool_search`/`tool_load` ou pela chamada direta. Nos cenários com quatro modelos (DeepSeek V4.1 flash, Qwen 3.8 flash, Beam e um Qwen 3.5 4B local, gratuito e fraco) a ferramenta foi usada com sucesso em 16 de 16, por chamada direta, com o mesmo número de chamadas do build antigo e de −9% a −22% de tokens, graças a uma pré-carga pelas palavras do usuário ("catálogo de skills", "handoff"); sem a pré-carga cada uso custava de 1 a 3 chamadas a mais (+12% a +37% de tokens) e uma quebra do cache num provedor que tem cache, e o modelo de 4B usou a ferramenta em só 2 de 4 cenários, duas vezes seguidas; antes de o prompt citar `memory_handoff` e de a chamada direta carregar, o DeepSeek pela API e o Gemma gravaram uma página de memória no lugar do handoff. **A medição com o OpenRouter, que foi o pedido, não foi possível** (sem chave no app; a cota diária de modelos gratuitos que o Ollama repassa já tinha esgotado) — ver `docs/MEMORIA-E-TOKENS.md` §3.6 |
| 44 | **MCP em duas telas (cartões e um editor de JSON) e sem como adicionar um servidor local pela tela** (o usuário: "por que aqui está em JSON e no outro em aplicativo?"; o "Conector personalizado" só aceitava endereço, então um servidor por comando só entrava pelo JSON). | **Uma tela só: Personalização → Conectores.** O "Conector personalizado" ganhou dois tipos: *Endereço na internet* e *Programa neste computador* (comando, argumentos um por linha, variáveis com as de nome de credencial mascaradas e no cofre, pasta de trabalho, tempo de partida), e o detalhe de um conector adicionado por você ganhou **Editar** (mesmo formulário preenchido; a credencial volta mascarada e, se não for mexida, continua a do cofre; permissões e filtros ficam). Configurações → MCP perdeu o editor de JSON e ficou com o aviso, o botão *Abrir Conectores* e a oferta de apagar cópias antigas. No código: `connect(id, { custom: { command, args, env, cwd, startTimeoutMs }, update })` em `src/main/connector-service.ts`; o filtro de entrada do IPC saiu de `index.ts` para `src/main/connector-input.ts`; a máscara nunca é gravada como segredo. | `tests/connector-service.test.ts` (+7: programa local, validações, tempo de partida, edição que mantém posição, política, pasta e tempo, credencial atrás da máscara, edição remota, recusas; dois testes falham sem as proteções), `tests/connector-input.test.ts` (6; o formulário falhava com "campo inválido: custom.url" porque o filtro só conhecia `url`: **achado pelo teste de tela**), `tests/connectors-ui-lib.test.ts` (+5), `scripts/ui-connectors.cjs` **100 checagens no Electron real** (editar mantém o segredo real no processo, a máscara nunca vai para o arquivo, adicionar um programa local pelo formulário, Configurações → MCP sem editor de JSON). Capturas `Prints/conectores-2026-10-27/20-…22-`. **Não testado:** um servidor MCP local de verdade com o formulário (o teste usa um servidor de teste por stdio) |

**A sessão travada, em fatos** (transcrição de `ses_f1d85e8b…`, 108 mensagens, teste real "validar um spinner animado"): (1) `browser_open` falhou duas vezes
(item 28); (2) `computer_screenshot` de 3 monitores (3840 px) sai a 0,33× e o DeepSeek **não tem visão** — a imagem nem chegou ao
modelo (item 29); (3) ele improvisou `chrome --headless --screenshot … | findstr`, que ficou 180 s e depois 90 s sem
saída (item 30; sem `--user-data-dir` o Chrome headless também pode colidir com o Chrome em uso). Nenhum desses era
"burrice" do modelo: eram lacunas do harness. Para o terceiro caso há agora o verificador que não depende de visão:
`check-animation.mjs --frames` (item 33).

Também concluída em sessão própria: **Revisão de melhorias** (coleta limitações recorrentes, falhas por ferramenta,
aprovações negadas, uso por provedor e memória; relatório salvo na memória e na Atividade; botão manual e
agendamento semanal; nada se aplica sozinho) — ver `docs/IMPROVEMENT-REVIEW.md`. Não revisei o resultado dela
além de typecheck, testes e build; o caminho com análise por IA só foi exercitado com modelo falso nos testes.

## 4. O que continua aberto, por prioridade

Todos os itens abaixo foram lidos no código (e vários reproduzidos) pelos auditores; os arquivos e critérios de
pronto estão nos relatórios de `docs/audit/`.

### P0 — segurança, perda de dados, resultado errado

1. **Confiança de projeto:** hooks e regras `allow` de `.forja/settings.json` do repositório rodam ao abrir qualquer projeto
   (reproduzido: um arquivo-isca executou e um servidor recebeu o conteúdo lido). Falta pedir confiança uma vez por pasta.
2. **Modo `unrestricted` (padrão) desliga tudo**, inclusive a guarda de credenciais que o código descreve como "em todos os modos".
3. **Regras de comando não entendem `&&`/pipes** (`git status && curl x` passa por um allow de `git status`); a lista de comandos
   perigosos deixa passar 18 de 26 casos de teste e bloqueia 5 de 7 inofensivos.
4. **MCP:** `mcp_call` tem risco fixo `exec`, então `approvalTools` e regras por ferramenta nunca valem; tokens de MCP ficam em texto
   claro no `settings.json`, entram no backup e aparecem na tela.
5. ~~Escape do workspace por *symlink* e `git_commit add_all` com segredos~~ **resolvido (itens 21)**; resta o editor de arquivos da UI, que grava por junção sem passar pelo `WorkspaceGuard`.
6. **Memória:** "esquecer" não apaga (o wiki do sidecar é um Git e os arquivos continuam recuperáveis); 7 de 12 gravações simultâneas
   falharam; corpo vai ao sidecar sem redação de segredos.
7. ~~Leitura de documentos (PDF lixo com `ok=true`, DOCX bomba)~~ **resolvido para recusar com clareza (item 21)**. Falta ler PDFs de verdade (renderizar páginas e usar o OCR nativo do Windows).
8. ~~Extensão do Chrome clicava em `<html>`~~ **resolvido e testado em Chrome real (item 16)**; falta carregar a extensão nova no seu Chrome (recarregar em `chrome://extensions`) e validar lá.
9. **Subagentes:** a fila única já impede ações sobrepostas no mouse/teclado (item 18), mas continuam disputando o foco; processos iniciados por eles ficam órfãos.
10. **Custo ilusório:** agora há aviso (item 22), mas os presets Anthropic/OpenAI continuam sem tarifa e o gasto dos subagentes segue fora do total do turno.
11. **Backup sem autenticação** (pacote forjado com hash recalculado é aceito) e a restauração não recarrega agendador/sessões;
    `settings.json` corrompido volta aos padrões sem aviso nem cópia.
12. **Interface:** ~~`window.prompt()`~~ resolvido (item 23); "Criar"/Ctrl+N persistem sessões vazias; edições não salvas em Configurações são apagadas por qualquer mudança.

### P1 — o que separa de um Claude Code

- Sem **CLI/headless/SDK** (bloqueia CI e automação) e sem fluxo de **PR/CI**.
- **Hooks:** 10 de ~33 eventos, e um hook de segurança que quebra deixa a ferramenta passar.
- **Skills:** descrições no prompt e YAML resolvidos (item 19); faltam skills de projeto (`.claude/skills`), `allowed-tools` e argumentos. **Instruções:** pais, `CLAUDE.local.md` e imports resolvidos (item 20); faltam `.claude/rules` por caminho e subpastas sob demanda.
- **Código:** `code_intelligence` é regex (sem Tree-sitter/LSP/índice; 93 s numa consulta e varre `repositorios/`).
- **Git:** sem gerente de branches, merge/conflito, diário nem worktree por subagente; 4 executores `git` diferentes.
- **Subagentes:** sem segundo plano, retomada nem isolamento; campos do frontmatter descartados em silêncio.
- **Windows:** timeout mata o comando em vez de mandá-lo para segundo plano e não há ferramenta PowerShell (saída que perdia o fim e CP850 ilegível: resolvidos, item 15).
- **Cache de prompt** instável (system prompt volátil, TTL fixo de 5 min).
- **Interface:** nenhuma lista virtualizada (grafo de memória O(n²) com 1.934 notas); links `http://` do chat não abrem; árvore de
  arquivos trunca em ~800 sem aviso; 10 das 18 seções de Configurações do Claude existem.
- **Telas sem equivalente:** Novidades, Apps e extensões, modal "Criar um projeto", Conta/Cobrança/Design systems/Reflexão,
  extensões `.mcpb/.dxt`, menus nativos, Skills "Descobrir".
- **Animações/SVG:** `svg-master` (ícones) e agora `animation-master` com `check-animation.mjs` (item 19). Criar SVG funcionou com DeepSeek
  (via `svg-designer`/`svg-verifier`, 274 s); a animação ainda precisa ser exercitada com modelo real (está no roteiro `ui-real-model.cjs`).
- **Web:** faltam envio/baixa de arquivos (`browser_upload`, download) e abas/popups pela extensão do Chrome; o agente não enxerga o painel de navegador do app.

### P2
Estilos de saída, plugins/marketplace no formato do Claude, `/goal`, OpenTelemetry, camada corporativa, Bedrock/Vertex, LSP completo.

## 5. Decisões que são suas

1. **Modo padrão `unrestricted`:** manter, mas com a guarda de credenciais (chaves SSH, nuvem, cofres) ligada mesmo nele?
   Hoje nada pergunta. Recomendo ligar só a guarda.
2. **Git:** **83 arquivos de código e teste estão fora do Git** (backup, documentos, imagens, mídia, observabilidade, plugins,
   qualidade, checkpoint, `lazy.ts`, `ask.ts`…) e há 112 arquivos modificados. Um disco ruim perde isso. Posso fazer um commit
   de segurança quando você mandar.
3. **Confiança de projeto** (P0-1): pedir confirmação ao abrir uma pasta com `.forja/settings.json`?
4. **Ferramentas preguiçosas:** `git_*`, `start_process`, `delete_path`, `code_intelligence` só entram depois de `tool_load`.
   O DeepSeek chamou `tool_search`/`list_agents` sem problema, mas modelos mais fracos podem não chamar. Mover as mais usadas para o
   conjunto fixo custa tokens por chamada. **Atualização (27/10, tarde):** foi na outra direção para nove ferramentas pouco usadas
   (o conjunto fixo foi de 31 para 22 ferramentas, −12% a −15% no piso). O risco apareceu como previsto: o Gemma, recusado ao chamar uma
   delas, gravou uma página de memória em vez de carregá-la; por isso a chamada direta pelo nome agora carrega e executa. Um modelo
   pequeno (Qwen 3.5 4B) confirmou o resto do risco: com as ferramentas fora da lista usou a certa em 2 de 4 cenários, duas vezes. O
   harness agora põe na lista, na primeira chamada do turno, a ferramenta que o usuário nomeia ("catálogo de skills", "handoff"): o 4B foi
   a 4 de 4 e os outros três modelos não gastaram nenhuma chamada a mais (`docs/MEMORIA-E-TOKENS.md` §3.6). Sem essas palavras o modelo
   continua tendo de achar a ferramenta sozinho.

## 6. Correções às afirmações do PROMPT MESTRE (seção 16)

- O instalador `release/Openclod Desktop-0.1.0-setup.exe` (840 MB) **não existe mais**; só há `release/win-unpacked`.
- "801 testes" estava desatualizado; hoje são **962**.
- O "E2E" do backup só confere que os botões renderizam; o backup real falhava com os dados desta máquina (corrigido, item 6).
- Os E2E de documentos, imagens, plugins e transcrição estavam quebrados desde a carga preguiçosa de ferramentas (corrigidos, item 12).
- Os módulos 14 (qualidade/autorreparação) e 17 estão praticamente por fazer, e o código dos módulos 11 e 18–29 estava fora do Git.
- Das 33 referências de pesquisa dos módulos 04–06, só 16 estão em `repositorios/_research`.

## 7. Mapa dos relatórios detalhados (`docs/audit/`)

| Arquivo | Conteúdo | Placar |
|---|---|---|
| `modulos-01-02-03-12-13.md` | Agent Core, subagentes, skills/hooks, provedores, planejamento | 236: ✅62 🟡110 ❌63 ❓1 |
| `modulos-04-05-06.md` | Computer Use, navegador, terminal e processos | 325: ✅105 🟡122 ❌95 ❓3 |
| `modulos-07-08-09-15.md` | Código, Git, contexto/memória, arquivos | 282: ✅49 🟡135 ❌95 ❓3 |
| `modulos-10-11-14-16a30.md` | MCP, plugins, qualidade, módulos 16–30 | 315: ✅84 🟡163 ❌61 ❓7 |
| `telas-vs-claude-desktop.md` | 107 capturas × componentes, 35 bugs, roteiro de 95 passos | 96: ✅22 🟡47 ❌20 ❓7 |
| `claude-code-capacidades.md` | 670 capacidades do Claude Code com URL, 25 maiores lacunas, o que o Openclod faz melhor, checklist de harness de qualidade | 670: ✅88 🟡296 ❌239 ➕46 ❓1 |

Limite honesto dos auditores: leram e rodaram testes focados e experimentos descartáveis; não abriram o Electron nem usaram o
computador. Os pontos marcados "reproduzido" nos relatórios foram executados com código real; os demais foram confirmados por
leitura. Números de linha podem ter se deslocado porque outra sessão editava o repositório ao mesmo tempo.

## 8. Arquivos criados ou alterados nesta rodada

Código: `src/main/orchestrator.ts`, `src/main/index.ts`, `src/main/settings.ts`, `src/main/activity-store.ts`,
`src/main/notifications.ts`, `src/core/agent/{runner,compaction}.ts`, `src/core/tools/{fs,git}.ts`, `src/core/util/file-lock.ts` (novo),
`src/core/session/store.ts`, `src/core/backup/service.ts`, `src/core/providers/{openai,anthropic}.ts`,
`src/core/observability/service.ts`, `src/shared/{types,api}.ts`, `src/renderer/src/{App.tsx,styles.css}`.
Testes novos: `tests/{fs-safety,tool-images,git-tools}.test.ts` e casos em runner, session-store, backup e compaction.
Scripts novos: `scripts/{harness-battery.ts,ui-real-model.cjs,ui-session-flows.cjs}`; corrigidos: `ui-{documents,images,plugins,media-transcribe}.cjs`.
