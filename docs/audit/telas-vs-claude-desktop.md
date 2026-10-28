# Auditoria de telas: Openclod Desktop × Claude Desktop (2026-10-26)

Auditor: sessão de leitura (somente leitura no código; nenhum arquivo existente alterado).
Escopo: as 107 capturas de `PrintClaude/` (Claude Desktop 3.6556.1, 1440×900), as 20 imagens soltas
`Prints/image*.png`, as capturas do Openclod em `Prints/`, o índice `PrintClaude/INDICE-TELAS.md`,
`docs/research/UI_COMPARISON.md`, `docs/ARCHITECTURE.md` e todo o renderer (`src/renderer/src`), mais os
trechos de `src/main` e `src/preload` que sustentam a interface.

## 0. Como ler este relatório

| Símbolo | Significado (critério usado) |
|---|---|
| ✅ | Equivalente e funcional **e** comprovado por roteiro E2E `scripts/ui-*.cjs` ou por evidência em `Prints/` |
| 🟡 | Existe, mas parcial (faltam itens, só visual, ou só atalho de prompt) |
| ❌ | Ausente (não achei código) |
| ❓ | Existe no código, mas sem verificação E2E nem captura que comprove |

Convenções:

- `arquivo:linha` é a posição no working tree no momento da auditoria. `App.tsx` tem muitas alterações não
  commitadas e estava sendo editado por outra sessão (as linhas se deslocaram entre 2 e 9 posições durante a
  leitura): tratar como ±10.
- "Backend" = o caminho do clique até o harness: **IPC real** (renderer → preload → `src/main` → `src/core`),
  **só visual** (nada acontece além de estado local), **prompt→chat** (o botão só preenche o composer),
  **localStorage** (estado só no renderer).
- Não abri o Electron, não rodei build nem a suíte completa. Rodei apenas
  `npx vitest run tests/ui-logic.test.ts tests/path-attachments.test.ts tests/browser-tabs.test.ts tests/questions.test.ts`:
  4 arquivos, 45 testes, todos verdes (reducer de atividade, blocos do transcript, anexos por caminho, abas do navegador).
- Itens marcados **[prever falha]** no roteiro da seção 4 são bugs que li no código e que o orquestrador deve
  confirmar ao vivo; não afirmo que reproduzi no app.

Evidências existentes que sustentam os ✅:

| Evidência | O que cobre |
|---|---|
| `scripts/ui-work.cjs` (perfil descartável, ferramentas reais, modelo roteirizado `FORJA_MOCK_SCRIPT`) | plano acima do composer, ponto "trabalhando", resumo/grupos de ferramentas, cartões de edição com diff, painel Tarefas em segundo plano |
| `scripts/ui-panes.cjs` + `docs/research/UI_COMPARISON.md` | Terminal (PTY), Alterações, Navegador (dev server), Arquivos (CodeMirror), layout do painel, ⋮ superior |
| `scripts/ui-voice.cjs`, `ui-mic-pill.cjs`, `ui-wispr.cjs` | microfone do composer, pílula, ditado global |
| `scripts/ui-slides.cjs`, `ui-worktrees.cjs`, `ui-plugins.cjs`, `ui-backup.cjs`, `ui-diagnostics.cjs`, `ui-notifications.cjs`, `ui-tts.cjs`, `ui-updater.cjs`, `ui-memory-provenance.cjs`, `ui-images.cjs`, `ui-documents.cjs`, `ui-media-transcribe.cjs` | slides, worktrees, plugins locais, backup, diagnóstico, notificações, voz/TTS, updater, memória/proveniência, imagens, documentos, transcrição |
| `Prints/openclod-2026-10-24/*`, `Prints/packaged-smoke-2026-10-25.png`, `Prints/<módulo>-2026-10-25/*` | telas do Openclod reais (Início, Artefatos, editor, grafo de memória, ambiente WSL, worktrees, configurações) |
| `scripts/smoke-packaged.cjs` | o renderer empacotado abre |
| `docs/research/UI_COMPARISON.md:28-33` (verificação **manual** documentada, sem script) | Projetos (2 cartões), Agendados (criar por modelo, "executar agora"), Personalização (criar skill), rodapé do composer. Marquei ✅ nesses casos pela evidência documentada + testes de backend (`tests/scheduler.test.ts`), mas eles merecem um E2E |
| **Sem nenhuma evidência E2E nem captura**: Cowork, Dispatch, Design, aprovações, perguntas, rewind, menus da sidebar, ErrorBoundary | ver ❓ e ❌ |

Atenção: `scripts/ui-shots.cjs` usa o seletor `.modal-tabs button` (CSS órfão, o `SettingsDialog` hoje usa
`.settings-nav`) e `scripts/ui-flows.cjs` depende de uma sessão já existente; ambos estão obsoletos (seção 5).

---

## 1. Matriz: tela do Claude × equivalente no Openclod

### 1.1 Início, Chat e Cowork

| ID | Claude (captura → o que tem) | Openclod (componente:linha) | Backend | Status | Evidência / lacuna |
|---|---|---|---|---|---|
| M01 | 00, 01, 110, `Prints/image.png`, `copy 9`: saudação "Bem-vindo…, {nome}", banner de limite ("Você usou 97%… Obter mais uso"), composer central | `HomeView.tsx:21-93` (saudação `:41`, banner `:55-77`); composer variante `home` | IPC real (settings, capabilities) | 🟡 | Saudação por nome (Configurações→Aparência) ✅ (`Prints/packaged-smoke-2026-10-25.png`). Banner de limite/"Obter mais uso" ❌: o banner do Openclod mostra o provedor e "Ver capacidades". Não há conceito de plano/limite semanal |
| M02 | Abas **Início/Code**, ← →, painel, janela (todas) | `Sidebar.tsx:362-377`, `Chrome.tsx:200-282`, histórico `App.tsx:1278-1292` | IPC real | ✅ | `Prints/openclod-2026-10-24/openclod-environment.png`, `ui-flows.cjs`. Janela sem moldura (`index.ts:989`) com controles próprios |
| M03 | Sidebar: Criar, Projetos, Artefatos, Agendados, Dispatch Beta, Design, Personalização, Mais (02) | `Sidebar.tsx:10-20,397-412` (+ Memória e Atividades, extras) | IPC real | ✅ | Itens presentes. Diferença: "Mais" abre uma página (`MorePages.tsx:353-378`), não expande |
| M04 | Botão **Criar** (+) | `Sidebar.tsx:379-396` → `App.tsx createSession` | IPC real | 🟡 | Persiste uma sessão vazia a cada clique (**BUG-06**); o Claude só abre o composer em branco |
| M05 | "Conversas e tarefas": busca + filtro (Tipo, Status, Última atividade, Agrupar por, Ordenar por) (120) | `Sidebar.tsx:445-470`, busca `:416-443`, `slice(0,60)` `:133` | localStorage/estado local | 🟡 | Busca ✅. "Filtro" é só ordem asc/desc (`:453-460`); sem Tipo/Status/Agrupar; lista cortada em 60 sem "ver mais" |
| M06 | Composer: `+`, Chat/Cowork, modelo, esforço, microfone, enviar (01, 111) | `Composer.tsx:763-933` | IPC real | ✅ | `ui-mic-pill.cjs`, `ui-voice.cjs`, `ui-work.cjs`. Spellcheck desligado (`Composer.tsx:717`, `index.ts:996`) |
| M07 | Menu de modelo: Fable/Opus/Sonnet/Haiku, Esforço, **Mais modelos**, **Modo rápido** (115, 117, 66, 67) | `Composer.tsx:524-543,835-869` | IPC real | 🟡 | Lista por provedor com busca (melhor que o Claude). Sem "Mais modelos" aninhado, sem "Modo rápido", sem atalhos 1–4 |
| M08 | Menu de esforço (116, 68) | `Composer.tsx:545-568,817-833` (`effortLevelsFor` em `shared/reasoning.ts`) | IPC real | ❓ | `UI_COMPARISON.md:33`: níveis cobertos por 19 testes, "não clicados com um modelo que suporte". Botão desabilitado durante turno (único que respeita `busy`, ver **BUG-02**) |
| M09 | Menu **+** (118, 71–73): arquivos/fotos Ctrl+U, pasta, GitHub, comandos, conectores, plugins, skills, design system, memória, gravar Skill | `Composer.tsx:607-615` | IPC real (anexos por caminho) | 🟡 | Anexar arquivo e pasta ✅ (`path-attachments.test.ts`). Faltam Ctrl+U, importar problema do GitHub, Conectores/Plugins/Skills/Sistema de design/Memória no menu, "Gravar uma Skill". Modos do agente ficam misturados neste menu |
| M10 | Cowork: **Projeto ou pasta** (menu com busca, projetos, Novo projeto, Adicionar pasta) (112) | `CoworkView.tsx:147-170` | IPC real | 🟡 | `<select>` nativo sem busca; "Adicionar pasta…" funciona (`:152-155`) |
| M11 | Cowork: **Auto** (Aprovar manualmente/automaticamente/Ignorar todas) (113) | `CoworkView.tsx:171-181` | IPC real (política **global**) | 🟡 | Só 3 opções; `value={permissionMode}` sem opção correspondente para `readonly`/`accept-edits` (**BUG-12**); altera `settings.policy.mode` de todo o app |
| M12 | Cowork: ícone de informação (114) | `CoworkView.tsx:182` | só visual | ❌ | Botão com `title` e sem handler: não abre nada |
| M13 | Cowork: **Em andamento** + "Limpar ativo" | `CoworkView.tsx:187-210` → `App.tsx clearSession` | só visual | 🟡 | "Limpar ativo" chama `clearSession`, que não faz nada na tela de Cowork sem sessão; lista limitada a 4 (`:195`) |
| M14 | Banner "Cowork em prévia" | `CoworkView.tsx:106-108` | só visual | ❌ | `onClick={hasRealProvider ? undefined : …}`: botão sem ação quando há provedor real |
| M15 | Rodapé da sidebar "Reiniciar para atualizar" (112, 121, 122) | updater só em Configurações→Sobre (`SettingsDialog.tsx:1997+`) | IPC real (`ui-updater.cjs`) | ❌ | Backend ✅, mas não há aviso nem botão na sidebar |

### 1.2 Projetos

| ID | Claude | Openclod | Backend | Status | Evidência / lacuna |
|---|---|---|---|---|---|
| M16 | 03, `Prints/image copy.png`: cards (nome, badge, descrição, data), busca, ordenar, **Novo projeto** | `ProjectsPage.tsx:80-154` | IPC real | ✅ | UI_COMPARISON ("2 cartões"); página visível ao fundo em `Prints/worktrees-2026-10-25/failed-create.png`. Card mostra caminho e nº de sessões (não descrição) |
| M17 | Busca + ordenar | `ProjectsPage.tsx:88-100` (`<select>` nativo) | estado local | ✅ | Ordem por atividade/nome |
| M18 | 121: modal "Criar um projeto" (nome, objetivo, usar uma pasta) | `App.tsx addProject` → `projects.pick()` | IPC real | ❌ | "Novo projeto" abre direto o seletor de pasta; sem nome/objetivo/instruções |
| M19 | 122: menu do card Fixar/Editar detalhes/Arquivar/Apagar | `ProjectsPage.tsx:46-78` | IPC real | 🟡 | Tem Nova sessão, Worktrees (✅ `ui-worktrees.cjs`), Explorer, Grafo, Remover, Excluir. Faltam Fixar, Editar detalhes, Arquivar |

### 1.3 Artefatos, Documentos, Design e Slides

| ID | Claude | Openclod | Backend | Status | Evidência / lacuna |
|---|---|---|---|---|---|
| M20 | 04–08, 26, `Prints/image copy 2.png`: galeria com abas Todos/Meus/Compartilhados, banner, "Crie algo novo" (4 cartões), cards com miniatura | `MorePages.tsx:30-241` | IPC real (`files.tree`) | 🟡 | É um navegador de arquivos do projeto (`.md/.html/.svg/.csv/.json/código`) (`:23`). Sem abas, sem miniaturas, sem proprietário/compartilhamento. "Crie algo novo" só preenche o composer (`:16-21,203-213`, prompt→chat) |
| M21 | 09, 10, 11, 08: busca, Ordenar por (Proprietário, Tipo, Data, Compartilhamento, Fixados), Grade/Lista, menu "+" | `MorePages.tsx:152-164` | estado local | 🟡 | Busca por caminho ✅. Ordenar/Grade-Lista/menu "+" ❌. Mostra no máx. 200 (`:73`) e o contador diz "200 arquivo(s)" enquanto o banner diz 667 (`Prints/openclod-2026-10-24/openclod-artifacts.png`) |
| M22 | Menu ⋮ por artefato | — | — | ❌ | Nenhum menu por item |
| M23 | 12–16, 19–21: editor de documento (título, aba, tipografia, blocos, `@Claude`) | `ArtifactStudio.tsx:59-249` (CodeMirror + preview) | IPC real (`files.read/write`) | 🟡 | Editor de código/Markdown com Editor/Preview/Dividido ✅ funcional, **mas o preview fica com 110 px (BUG-04)**; sem blocos ricos/tipografia; sem Ctrl+S (**BUG-10**) |
| M24 | 17: botão **Conversar** (chat lateral no documento) | — | — | ❌ | |
| M25 | 18: Compartilhar/Exportar, convidar por e-mail, link privado | `ArtifactStudio.tsx:145-164,227-231` | IPC real | 🟡 | Só "Exportar HTML" para slides. Sem compartilhamento (fora de escopo: serviço de nuvem) |
| M26 | Apresentações (slides) | `SlideStudio.tsx`, `ArtifactStudio.tsx:166-169` | IPC real | ✅ | `ui-slides.cjs` + `Prints/slides-2026-10-25/*` (edição, apresentar, exportar). Defeito visual: o painel de preview em modo Dividido aparece cortado em `01-slide-editor.png` (**BUG-04**) |
| M27 | Preview de HTML/SVG/CSV/JSON | `ArtifactStudio.tsx:166-201` (iframe `sandbox="allow-scripts"`) | estado local | 🟡 | Sandbox correto; recarrega o iframe a cada tecla (`:166-201`, sem debounce); CSV cortado em 200 linhas sem aviso (`:55`) |
| M28 | 34–38, `copy 7`: **Design** (abas, banner, "Crie algo novo", galeria agrupada por mês) | `MorePages.tsx:247-273` | prompt→chat | 🟡 | Página estática: abas Todos/Meus/Compartilhados **sem handler** (`:260-262`) e botão que preenche o composer |
| M29 | Claude Design standalone (templates, sistema de design, enviar) | — | — | ❌ | UI_COMPARISON classifica como fora de escopo |
| M30 | Painel (Dashboard, Beta) | `MorePages.tsx:20` (`ARTIFACT_KINDS`) | prompt→chat | 🟡 | Só o prompt; nenhum editor/visualizador específico |
| M31 | Banner "O Claude Design agora está aqui" | — | — | ❌ | N/A (marca da Anthropic) |

### 1.4 Agendados

| ID | Claude | Openclod | Backend | Status | Evidência / lacuna |
|---|---|---|---|---|---|
| M32 | 27, `copy 3`: lista, busca, estado vazio com cronômetro e 6 modelos | `ScheduledPage.tsx:37+` (`TEMPLATES`), busca, estado vazio `:471+` | IPC real (`Scheduler`) | ✅ | UI_COMPARISON: criada a partir de modelo, "executar agora" gerou sessão; `tests/scheduler.test.ts` (relógio injetado). Os 6 modelos são para desenvolvedores, não os 6 do Claude |
| M33 | 29, `copy 4`: Ordenar por Próxima execução/Nome | `ScheduledPage.tsx:412-418` | estado local | ✅ | `<select>` nativo |
| M34 | 28, `copy 5`: Nova tarefa → **Criar com o Claude** / Configurar manualmente | `ScheduledPage.tsx:381-392` | IPC real | 🟡 | Só "Configurar manualmente" + modelos; "Criar com o Claude" ❌ |
| M35 | Menu por tarefa, executar agora, pausar, editar, apagar | `ScheduledPage.tsx:345-378` (apagar com `window.confirm` `:375`) | IPC real | ✅ | UI_COMPARISON; recarrega a cada 15 s (`:334`) |

### 1.5 Dispatch

| ID | Claude | Openclod | Backend | Status | Evidência / lacuna |
|---|---|---|---|---|---|
| M36 | 31, 32, `copy 6`: Configurações (Manter ativo, Notificações móveis, Permitir todas as ações do navegador, Uso do computador, Permissões de código) | `MorePages.tsx:283-344` | IPC real só para "Manter ativo" | 🟡 | "Manter computador ativo" ✅ (`powerSaveBlocker`, `index.ts:2081-2090`). "Notificações móveis" é `checked disabled` (`:306`), os demais ❌; "Permissões" abre Configurações→Permissões (`App.tsx` `openSettingsAt('policy')`) |
| M37 | Saídas, cartão "Trabalhe com o Claude direto…", conversa com composer, ⋮ | `MorePages.tsx:325-340` | só visual | ❌ | Texto assume que o controle remoto por celular "ainda não está disponível" (honesto). Sem thread nem composer próprios |

### 1.6 Personalização (Skills / Conectores / Plugins)

| ID | Claude | Openclod | Backend | Status | Evidência / lacuna |
|---|---|---|---|---|---|
| M38 | 47, 108/109: Skills **Meus** (Criado por você / Da Anthropic) | `CustomizePage.tsx:307-352` | IPC real | 🟡 | Cards só de leitura: sem abrir, editar, desativar ou remover. Criar skill ✅ (UI_COMPARISON) |
| M39 | 48, 50–54, 56, `copy 8`: Skills **Descobrir** (Data, Novas, Mais instaladas, Categorias com contagem) | `CustomizePage.tsx:294-302` (toggle) | só visual | ❌ | O toggle Meus/Descobrir só altera Conectores (`:365`); em Skills, Plugins e Agentes **não muda nada** |
| M40 | 49: **Adicionar** → Fazer upload / Criar / Criar com o Claude / Gravar tela | `CustomizePage.tsx:328-330`, `NewSkillForm :23-67` | IPC real | 🟡 | Só "criar" (nome/descrição/instruções). Sem upload `.zip`/`SKILL.md`, sem "criar com o agente", sem gravação |
| M41 | 41–43: Conectores **Meus** (tabela Tipo/Status, Reconectar/Vincular) | `CustomizePage.tsx:395-460` | IPC real (MCP + OAuth DCR/PKCE) | 🟡 | Cards (não tabela) com estado e "Entrar com OAuth"; "Reconectar todos". Sem desativar/remover aqui (só no JSON de Configurações→MCP). Consentimento OAuth real ainda não concluído (`docs/PENDENCIAS-2026-10-25.md`) |
| M42 | Conectores **Descobrir** / personalizado | `CustomizePage.tsx:365-418` (catálogo MCP); JSON em `SettingsDialog.tsx:1586-1636` | IPC real | 🟡 | Catálogo instalável ✅ (`tests/catalog-integration.test.ts`). Credenciais pedidas por `window.prompt` (`:158`), que o Electron não suporta (**BUG-05**) |
| M43 | 45, 46: Plugins Meus/Descobrir | `CustomizePage.tsx:521-700` | IPC real (plugins locais) | ✅ | Instalar pasta local, ativar/desativar, remover: `ui-plugins.cjs`. "Descobrir" é lista fixa com selo "Anthropic Directory" (`:638`) e "From Anthropic" (`:600`) |
| M44 | — (extras do Openclod) Agentes e Hooks | `CustomizePage.tsx:708-790` | IPC real | ❓ | Sem E2E |

### 1.7 Code: sessões, ambientes, painéis

| ID | Claude | Openclod | Backend | Status | Evidência / lacuna |
|---|---|---|---|---|---|
| M45 | 62: **Nova sessão** (cartão de ambiente, "Escolher ambiente", sessões bloqueadas, Novidades, banner de limite) | `App.tsx:1676-1711` ("Pronto para começar"), `Transcript.tsx:452-465` | IPC real | 🟡 | Estado vazio com 3 atalhos de exemplo; sem cartão de ambiente, sem sessões "bloqueadas", sem Novidades |
| M46 | 62: rodapé **ambiente · pasta · Worktree · permissão · modelo/esforço · contexto** | `Composer.tsx:938-983` | IPC real | 🟡 | Permissão e ambiente ✅ (ambiente só aparece se `settings.environments` existir); pasta e "Worktree" ❌ no rodapé (worktree só pelo menu do projeto `Sidebar.tsx:191-196`) |
| M47 | 63, 64: **Escolher ambiente** (busca, Local/Nuvem/Remote Control/WSL, "Mais", Novo ambiente) | `Composer.tsx:581-588,946-954` | IPC real (`environmentSpawn`, `core/tools/shell.ts:47-60`) | 🟡 | Lista simples (Local/WSL/SSH/nuvem). **Antes de existir sessão, a escolha é ignorada** (`App.tsx:1018`, **BUG-07**). Ferramentas de arquivo continuam locais (`docs/AMBIENTES-E-ARTEFATOS.md`) |
| M48 | 65: **Novo ambiente** (Local/Nuvem/SSH/Remote; nome, "Executar em", pastas, Worktree, variáveis) | JSON em `SettingsDialog.tsx:139,469-478` | IPC real | 🟡 | Sem formulário: o usuário edita JSON em Configurações→Permissões. Sem variáveis de ambiente |
| M49 | 70: menu de permissões (Automático, Manual, Aceitar edições, Plano, Ignorar) "esta sessão" | `Composer.tsx:572-579,938-945` | IPC real (**global**) | 🟡 | 5 modos ≠ dos 5 do Claude; "Plano" é modo do agente, não permissão; escopo global em vez de por sessão; rótulos inconsistentes (**BUG-13**) |
| M50 | 74, 75: comandos `/` (plugin, model, effort, fast, plan, permissions, skills, workflows, usage, config, storage, sandbox, theme, resume, login…) | `Composer.tsx:94-103,722-760` | IPC real | 🟡 | 8 comandos em pt (`/novo /compactar /exportar /arquivar /limpar-fila /tema /config /skills`) + skills. Faltam model/effort/plan/permissions/usage/resume/login |
| M51 | 76, 77: **Novidades** (release notes por versão) | — | — | ❌ | `grep` por "Novidades" no renderer não retorna nada |
| M52 | 78–81, `copy 12`: Terminal (abas, ⋮ com Estilo do cursor, Cursor piscante, Copiar ao selecionar, Histórico 10.000) | `TerminalPane.tsx:36-234` | IPC real (ConPTY) | ✅ | `ui-panes.cjs`: `echo FORJA_TERM_OK` ida e volta. Menu só cria/encerra terminais; cursor piscante e scrollback 5000 fixos (`:47-48`); **BUG-20** (Ctrl+C) |
| M53 | `copy 14`: Navegador (abas, URL, detecção de dev server, "Usar esta", `launch.json`) | `BrowserPane.tsx:1-395` | IPC real (`preview.detect`, `<webview>` isolado) | ✅ | `ui-panes.cjs`: servidor `npm run dev` aberto, `.forja/launch.json` gravado |
| M54 | `copy 15-17`: Arquivos (árvore, filtro/`?`, editor, ⋮ de opções) | `FilesPane.tsx:44+` (CodeMirror 6) | IPC real | ✅ | `ui-panes.cjs`: salvar mudou o arquivo no disco; Ctrl+Shift+Y (`:238`). Autosave "não exercitado" |
| M55 | `copy 13`: Alterações (lista/árvore, diff, vazio "precisam de um repositório Git") | `ChangesPane.tsx:60-135,327-400` | IPC real (`git status v2`) | ✅ | `ui-panes.cjs` (`M README.md +2 −1`). Extra: comentários por linha de diff (`:119-135`). Cada linha de diff é um nó DOM (**BUG-15**) |
| M56 | `copy 11`, 84: painel da sessão (Ambiente, Contexto detalhado, Conectores, Saídas) | `SessionPanel.tsx:286-470` (`ContextPane`) | IPC real | 🟡 | Seções Ambiente/Contexto/Conectores/Saídas ✅, mas o detalhamento usa constantes inventadas (`:280-281`, **BUG-21**). Sem "Remote Control" |
| M57 | `copy 19`: ⋮ superior (Chat lateral Ctrl+;, Tarefas em segundo plano, Manter computador ativo) | `App.tsx:1473-1502`, `TasksPanel.tsx`, `RewindDialog.tsx` | IPC real | 🟡 | Tarefas em segundo plano ✅ (`ui-work.cjs`: encerrar processo). Manter ativo ✅. "Chat lateral" só via "Voltar ou ramificar conversa" (`forkConversation`), sem Ctrl+; |
| M58 | `copy 18`: layout do painel (Mover ← → ↑ ↓, Preencher e organizar, Abrir em nova janela) | `SessionPanel.tsx:147-162` | localStorage | 🟡 | Maximizar e esquerda/direita ✅ (`ui-panes.cjs`). Mover para cima/baixo, "preencher e organizar" e nova janela ❌ |
| M59 | 84, 86: grupos de ferramentas expansíveis ("Executou 6 comandos") | `Transcript.tsx` (`ToolGroup`), `lib/groups.ts`, `ToolCard.tsx:89-168` | IPC real | ✅ | `ui-work.cjs` + `tests/ui-logic.test.ts` (summaries e blocos) |
| M60 | 84: cartões de edição `+330 −2` | `EditCard.tsx` | IPC real | ✅ | `ui-work.cjs` |
| M61 | 86: imagens/saídas de ferramenta no transcript | `ToolCard.tsx:141-152`, lightbox `Transcript.tsx:545-564` | IPC real | ✅ | `ui-images.cjs`, `Prints/images-2026-10-25/01-image-tools.png` |
| M62 | 84: menu do título da sessão (renomear, etc.) | `Chrome.tsx:221-228`, `App.tsx:1447-1472` | IPC real | ❓ | Sem E2E; apagar usa `window.confirm` (`:1467`) |
| M63 | 62, 83: sessões na sidebar do Code: projetos, "sessão aninhada", ponto de atividade, estado "Bloqueada/Pronta" | `Sidebar.tsx:291-357` | IPC real | 🟡 | Ponto "trabalhando" ✅ (`ui-work.cjs`). Sem estados bloqueada/pronta, sem aninhamento, sem fixar |
| M64 | Pedido de aprovação de ferramenta | `ApprovalDock.tsx:20-73` | IPC real | ❓ | Sem E2E; perde-se ao trocar de sessão (**BUG-01**) |
| M65 | Perguntas do agente | `QuestionDock.tsx`, `QuestionCard.tsx` | IPC real | ❓ | `tests/questions.test.ts` cobre a lógica, não a UI |
| M66 | Plano | `PlanDock.tsx`, `PlanStepDetail.tsx` | IPC real | ✅ | `ui-work.cjs` ("0/3 Plano", itens ativos) |
| M67 | Voltar/ramificar conversa | `RewindDialog.tsx` | IPC real | ❓ | `tests/rewind.test.ts` (lógica); subtítulo contraditório (`:45` vs `:54-57`) |
| M68 | Worktrees ("Worktree" no rodapé) | `WorktreeDialog.tsx:99+` | IPC real | ✅ | `ui-worktrees.cjs`, `Prints/worktrees-2026-10-25/*` |

### 1.8 Configurações (as 18 seções do Claude)

O Openclod tem **10 abas** (`SettingsDialog.tsx:69`, nav `:534-569`): Provedores, Aparência, Voz, Permissões, Memória,
MCP, Backup, Harness, Diagnóstico, Sobre. É um único formulário com "Salvar alterações" (`:428-508`), sem busca e sem
agrupamento "Este computador / Personalização".

| ID | Seção no Claude (captura) | Equivalente no Openclod | Backend | Status | Evidência / lacuna |
|---|---|---|---|---|---|
| M69 | Geral (91, 101) | Aparência `SettingsDialog.tsx:902-1016` | IPC real | 🟡 | Nome e tema claro/escuro ✅; falta tema "Sistema", passe de convidado, tema do diff. Rótulo "Como o **Claude** deve chamar você?" (`:904`) é vazamento de marca |
| M70 | Conta (92) | — | — | ❌ | Só `profileName` |
| M71 | Privacidade (93) | Backup `SettingsDialog.tsx:1767-1951` | IPC real | 🟡 | "Exportar dados" ≈ Backup/Exportar configuração (`ui-backup.cjs`). Sem "Conversas compartilhadas", "Arquivos enviados", metadados de localização (N/A) |
| M72 | Cobrança (94) | — | — | ❌ | N/A (sem plano) |
| M73 | Uso (95) | consumo por provedor `SettingsDialog.tsx:161,298-301` | IPC real (`provider-usage.ts`) | 🟡 | Tokens/custo por provedor ✅; sem limite semanal/créditos/redefinições |
| M74 | Recursos (96) | Harness + limites `SettingsDialog.tsx:123-134,1953-1993` | IPC real | 🟡 | Agentes automáticos, todos os modelos, limites de turno ✅; sem "Modo de acesso a ferramentas", artefatos com IA, visualizações |
| M75 | Memória (97) | aba Memória `:1638-1765` + `MemoryPage.tsx` | IPC real | ✅ | `ui-memory-provenance.cjs`; exportar `.md`/importar `.md`/**importar ZIP** (`MemoryPage.tsx:205-255`). Faltam "importar de outros provedores de IA", "incluir temas sensíveis", Profile/Tópicos, campo "Diga ao Claude o que mudar" |
| M76 | Design systems (98) | — | — | ❌ | |
| M77 | Reflexão (99) | — | — | ❌ | (a página Atividades `ActivityPage.tsx` é outra coisa: trilha de eventos) |
| M78 | Tempo e foco (100) | horas silenciosas `SettingsDialog.tsx:125-133,990-1015` | IPC real | 🟡 | Apenas silêncio de notificações (`ui-notifications.cjs`); sem lembretes de pausa nem dias da semana |
| M79 | Claude Code (101, 104) | Permissões `SettingsDialog.tsx:1220-1585` | IPC real | 🟡 | Modo, regras allow/ask/deny, hooks, ambientes (JSON), limites ✅. Faltam "classificar estados das sessões", "alternar modelos", aparência do diff |
| M80 | Cowork (102) | Permissões (`allowedRoots`) + Dispatch | IPC real parcial | 🟡 | Pastas confiáveis ≈ `allowedRoots`; sem dispositivos confiáveis, "Arquivos do Cowork", navegador preferido |
| M81 | Claude in Chrome (103) | companion + modo do navegador `SettingsDialog.tsx:163-174` | IPC real | 🟡 | Instalar/verificar a extensão (`install-chrome-companion.mjs`); a extensão precisa ser carregada à mão (`docs/PENDENCIAS-2026-10-25.md`). Sem lista de sites permitidos/bloqueados |
| M82 | Sistema (105) | Sobre/Voz/menus | IPC real parcial | 🟡 | Versão ✅, atalho de ditado ✅ (Voz), manter ativo ✅ (menu ⋮), bandeja existe (`index.ts:963`) mas sem toggle. Faltam executar na inicialização, armazenamento, navegadores conectados; atalho Ctrl+Alt+F fixo (`index.ts:2317`) |
| M83 | Extensões (107) | — | — | ❌ | Sem `.mcpb`/`.dxt`; plugins por pasta existem em Personalização |
| M84 | Desenvolvedor (107) | aba MCP `SettingsDialog.tsx:1586-1636` | IPC real | 🟡 | Editor JSON de servidores MCP ✅ (valida e troca de aba em erro, `:431-443`). Sem "abrir pasta de logs/config" |
| M85 | Skills (108, 109) | Personalização → Skills | IPC real | 🟡 | ver M38–M40 |
| M86 | Conectores (109, 110) | Personalização → Conectores | IPC real | 🟡 | ver M41–M42 |
| M87 | Campo de **busca** de configurações | — | — | ❌ | |
| M88 | Extras do Openclod sem equivalente no Claude: Provedores, Voz, Backup, Harness, Diagnóstico, Sobre | `SettingsDialog.tsx:579-2139` | IPC real | ✅ | `ui-tts.cjs`, `ui-backup.cjs`, `ui-diagnostics.cjs`, `ui-updater.cjs`, `ui-notifications.cjs` |

### 1.9 Apps e extensões, menus do aplicativo, atalhos

| ID | Claude | Openclod | Backend | Status | Evidência / lacuna |
|---|---|---|---|---|---|
| M89 | 59–61: modal **Apps e extensões** (Chrome, Microsoft 365, Claude Code, JetBrains, Slack, celular) | — | — | ❌ | Só o companion do Chrome em Configurações |
| M90 | 88: menu hambúrguer **Arquivo / Editar / Visualizar / Ir / Ajuda** | `App.tsx:1417-1445` (lista plana) + `Menu.setApplicationMenu(null)` (`index.ts:2239`) | IPC real | 🟡 | Um único popover; item "Atalhos…" é uma linha `disabled` com texto longo (`:1444`) |
| M91 | 89: Arquivo (Nova sessão Ctrl+N, nova janela, conversa lateral, abrir arquivo/pasta, Configurações Ctrl+Vírgula, fechar sessão Ctrl+W, fechar janela, reabrir Ctrl+Shift+T, Sair) | `App.tsx:1417-1445`, atalhos `:658-698` | IPC real | 🟡 | Ctrl+N ✅, Ctrl+, ✅, Ctrl+B (extra), Ctrl+Shift+E (extra), abrir pasta ✅ sem atalho. Faltam nova janela, abrir arquivo, Ctrl+W, Ctrl+Shift+T, Sair |
| M92 | 90: Editar (Desfazer, Refazer, Recortar, Copiar, Colar, Excluir, Selecionar tudo, Localizar Ctrl+F/F3/Shift+F3, Localizar nos arquivos) | — | — | ❌ | Atalhos nativos funcionam em `input/textarea`; sem menu, **sem menu de contexto (botão direito)** (**BUG-17**) e sem Localizar |
| M93 | Visualizar / Ir / Ajuda | — | — | ❌ | Sem zoom (Ctrl +/−), recarregar, tela cheia; só F12/Ctrl+Shift+I (`index.ts:1042-1046`) |
| M94 | Navegação ← → na barra de título | `Chrome.tsx:210-211`, `App.tsx:1278-1292` | estado local | ✅ | Histórico de sessões visitadas |
| M95 | Atalho de Entrada Rápida global (Ctrl+Alt+Space) e de ditado (Ctrl+D) | `DictationHost.tsx`, `index.ts:2317`, Configurações→Voz | IPC real | 🟡 | Ditado global ✅ (`ui-wispr.cjs`) mas sem atalho padrão (migração v4→v5, `settings.ts:194-197`; `CLAUDE.md` ainda diz "padrão Control+Alt+Space"). Sem "Entrada Rápida" |
| M96 | Bandeja do sistema | `index.ts:963` (`createTray`) | IPC real | ❓ | Sem E2E, sem toggle; fechar a janela encerra o app (`window-all-closed → quit`) |

### 1.10 Transversais

| ID | Aspecto | Evidência no código | Status |
|---|---|---|---|
| X01 | Estados vazios | Existem para: sessões (`Sidebar.tsx:351,467`), projetos (`ProjectsPage.tsx:101-112`), artefatos (`MorePages.tsx:188-199`), agendadas, plugins, skills, terminal, alterações. Faltam para Design real (estático) e Dispatch | 🟡 |
| X02 | Estados de erro | `error-bar role="alert"` fixo, sem auto-fechar (`App.tsx:1805-1812`); `toast` 6 s sem `role=status` (`:1925-1933`); `inline-error` por página. `ErrorBoundary` só envolve o workspace e o `SessionPanel` (`App.tsx:1800`, `SessionPanel.tsx:201-245`); **sem boundary na raiz** (`main.tsx:8-12`) e `render-process-gone` só registra log (`index.ts:1048-1050`) | 🟡 |
| X03 | Estados de carregando | Texto "Lendo…", "Carregando catálogo…", spinner no microfone, `Abrindo terminal…`. Sem skeletons; o app inteiro não tem tela de carregamento inicial (`settings=null` ⇒ sem `SettingsDialog`, sem tema) | 🟡 |
| X04 | Acessibilidade | 157 `title=` e só 29 `aria-label` em ~14.900 linhas de TSX; botões de ícone dependem de `title`; `MenuPopover` sem setas/foco (`Chrome.tsx:93-140`); `role=menu` com `div` entre `menu` e `menuitem`; `.side-session` é `div role=button` com `<button>` dentro (`Sidebar.tsx:243-288`); `aria-hidden` no painel com conteúdo focável (`SessionPanel.tsx:169`); sem focus trap nos 8 `role=dialog`; `:focus-visible` global existe (`styles.css:133`) mas há 18 `outline:none/0` | 🟡 |
| X05 | Contraste (cálculo manual WCAG 2.1) | `--text-3` é usado 240× em `styles.css`. Escuro `#827f77` sobre `#151515` = 4,56:1 (passa por pouco), sobre `--elevated #1f1f1f` ≈ 4,1:1 e `--hover #232323` ≈ 3,9:1 (falha). Claro `#8a877d` sobre `#faf9f5` = 3,4:1 e sobre `#fff` ≈ 3,6:1 (**falha AA** em todo texto secundário) | 🟡 |
| X06 | Responsividade / janela estreita | Janela com mínimo 1060×680 (`index.ts:986-989`); breakpoints em 1240/1080 (blocos **duplicados** em `styles.css:5415-5430` e `:6949-6965`) e 900/800/760 só para memória, atividade, slides, worktree. Painel lateral 600 px (padrão) + sidebar 248-300 px deixa 160-212 px para o chat a 1060 px (`App.tsx:84-95`, `SessionPanel.tsx:63-64` sem limite pela janela). Não há atalhos de zoom | 🟡 |
| X07 | Tema claro/escuro | Tokens em `styles.css:20-66`; só `dark`/`light` (sem "Sistema", sem `prefers-color-scheme`); o tema só é aplicado depois de carregar `settings` (`App.tsx:415-419`), então usuários do tema claro veem um flash escuro; a prévia só muda ao salvar (texto em `SettingsDialog.tsx:916`) | 🟡 |
| X08 | i18n (mistura pt/en) | Interface praticamente toda em pt-BR (`lang="pt-BR"`). Vazamentos: "From Anthropic" e "Anthropic Directory" (`CustomizePage.tsx:600,638`), "Como o Claude deve chamar você?" (`SettingsDialog.tsx:904`), `.forja.json` no nome do arquivo exportado (`App.tsx:1178`), caminho errado `%APPDATA%\Openclod Desktop\skills` (`:1256`), "Ultrarrestrito" (**BUG-13**) | ✅ (poucos vazamentos) |
| X09 | Atalhos de teclado | `Ctrl+,` `Ctrl+B` `Ctrl+N` `Ctrl+Shift+E` `Esc` (`App.tsx:658-698`); `Enter`/`Ctrl+Enter` no composer; `Ctrl+Shift+Y` no painel de arquivos; `Ctrl+Alt+F` global; `F12`. Ausentes: Ctrl+W, Ctrl+Shift+T, Ctrl+U, Ctrl+F, Ctrl+; (chat lateral), zoom | 🟡 |
| X10 | Virtualização / listas grandes | Nenhuma lista é virtualizada: `Transcript.tsx:467` (todas as mensagens), `Sidebar.tsx:349-353` (sessões por projeto), `ProjectsPage.tsx:114`, `MemoryPage.tsx:418`, `ChangesPane.tsx:~85` (linha de diff = nó DOM), `MemoryGraph.tsx:106-152` | ❌ |
| X11 | Listeners / vazamentos | Os efeitos principais limpam (`App.tsx:421-602`, `Chrome.tsx:96-109`, `TerminalPane.tsx:89-97`, `BrowserPane.tsx:97-105`, `DictationHost.tsx:180-191`). Exceções: `SessionPanel.tsx:127-145` (sem `pointercancel`/`lostpointercapture`), `useDictation.ts` é código morto com listeners próprios, `activityBySession` nunca é podado | 🟡 |

### 1.11 Mapa das imagens soltas `Prints/image*.png`

Todas as 20 são capturas do **Claude Desktop** (nenhuma mostra erro do Openclod). Mapeamento:

| Arquivo | Conteúdo | Linha da matriz |
|---|---|---|
| `image.png`, `image copy 9.png` | Início com banner de uso e composer | M01, M06 |
| `image copy.png` | Projetos | M16 |
| `image copy 2.png` | Artefatos (galeria) | M20 |
| `image copy 3/4/5.png` | Agendados vazio, ordenar, Nova tarefa | M32–M34 |
| `image copy 6.png` | Dispatch | M36–M37 |
| `image copy 7.png` | Design | M28 |
| `image copy 8.png` | Personalização → Skills → Descobrir | M39 |
| `image copy 10.png` | Code: sessão com composer (Ignorar permissões, Opus 5.5 Extra) | M49 |
| `image copy 11.png` | Painel da sessão (Ambiente, Contexto 87%, Conectores, Saídas) | M56 |
| `image copy 12.png` | Terminal | M52 |
| `image copy 13.png` | Alterações (vazio) | M55 |
| `image copy 14.png` | Navegador (dev server detectado) | M53 |
| `image copy 15/16/17.png` | Arquivos, menu ⋮ e vazio | M54 |
| `image copy 18.png` | Layout do painel (Mover / Preencher e organizar / nova janela) | M58 |
| `image copy 19.png` | ⋮ superior (Chat lateral, Tarefas, Manter ativo) | M57 |

---

## 2. Bugs e riscos de interface (lidos no código; reproduzir ao vivo)

Severidade: **P0** perda de dados, trabalho abortado ou recurso quebrado; **P1** comportamento errado
frequente; **P2** polimento. IDs referenciados na matriz e no roteiro.

### P0

**BUG-01 — Aprovação pendente some ao trocar de sessão; sessões em segundo plano nunca pedem aprovação.**
- Onde: `App.tsx:256,269` (`setApprovals([])` em `clearSession`/`applySession`), `App.tsx:463` (`if (event.sessionId !== activeSessionRef.current) return` antes de `approval_request`), `src/main/orchestrator.ts:1030-1048` (a pendência existe só em `this.pending` na memória, com timeout de 5 min), `orchestrator.ts:1701-1704` (`approvalsFor` devolve `state.approvals`, mas nenhum código chama `approvalsFor` e `state.approvals` só é inicializado vazio em `core/session/store.ts:160`).
- Reproduzir: modo "Perguntar"; peça uma tarefa que rode comando; quando o `ApprovalDock` aparecer, clique em outra sessão e volte. O cartão sumiu, o composer parece ocioso e o agente fica bloqueado até "tempo de aprovação esgotado" (nega sozinho). Para tarefas agendadas/segundo plano a aprovação nunca aparece e a notificação nativa (`:562`) não dispara.
- Mesmo vale para `question_request` (`:568-579`) e `budget`.

**BUG-02 — Trocar modelo, modo, esforço ou ambiente no meio de um turno aborta o turno.**
- Onde: `orchestrator.ts:845-853,863-870` (`setMode/setEffort/setModel/setEnvironment` chamam `dropRunner`, que faz `runner.abort()`, `:442-446`). `Composer.tsx:837-846` (botão de modelo), `:948` (ambiente) e `:592-604` (modos) não verificam `busy`; só o esforço faz (`:818`).
- Reproduzir: envie uma tarefa longa, abra o menu de modelo durante a execução e escolha outro modelo. O turno termina como "cancelado" sem aviso.

**BUG-03 — Salvar qualquer configuração devolve o modelo da sessão ao padrão do provedor.**
- Onde: `App.tsx:1139-1152` (`saveSettings` compara `provider.model !== session.meta.model` e chama `sessions.setModel(..., provider.model)`).
- Reproduzir: provedor com 2+ modelos; escolha o modelo que **não** é o padrão na sessão; troque o modo de permissão pelo composer (ou o select do Cowork), que chama `saveSettings`. O seletor volta ao modelo padrão e `setModel` ainda aborta runners ociosos (`dropRunner`).

**BUG-04 — Preview do editor de artefatos e de slides fica cortado em 110 px.**
- Onde: colisão de classe: `styles.css:9857-9864` (`.artifact-preview { height:110px; display:grid; place-items:center }`, usada pelos cards de sessão `MorePages.tsx:220`) e `styles.css:10800-10805` (preview do estúdio) só redefine `min-width/overflow/padding/background`; `height` e `display:grid` vazam.
- Evidência: `Prints/openclod-2026-10-24/openclod-artifact-editor.png` e `Prints/slides-2026-10-25/01-slide-editor.png` mostram o painel direito com ~100 px de altura e o conteúdo cortado ("Demonstr…").
- Reproduzir: Artefatos → abrir um `.md` ou `.openclod-slides.json` → Dividido ou Preview.

**BUG-05 — `window.prompt()` não é suportado pelo Electron.**
- Onde: `CustomizePage.tsx:158` (credenciais de conectores do catálogo MCP, em texto claro) e `SettingsDialog.tsx:1704` (motivo para invalidar página de memória). O Electron lança `prompt() is and will not be supported`; no primeiro caso a exceção escapa de `installCatalog` sem feedback.
- Reproduzir: Personalização → Conectores → Descobrir → "Adicionar" em um conector que exige variável; Configurações → Memória → "Invalidar". Esperado pelo código: pedir o valor. Previsto: nada acontece / erro no console. **Confirmar ao vivo.**

### P1

**BUG-06 — "Criar", Ctrl+N e "+" persistem sessões vazias.**
- Onde: `Sidebar.tsx:379-396` → `App.tsx createSession` (`:308+`), `App.tsx:668-674` (Ctrl+N), título padrão `core/session/store.ts:144`; o auto-título só ocorre na 1ª mensagem (`orchestrator.ts:644`). Não há limpeza de sessões vazias.
- Evidência: `Prints/openclod-2026-10-24/openclod-artifacts.png` lista 4 "Nova sessão" (6 min, 1 h, 5 h, 14 h) na sidebar.
- Reproduzir: clicar em Criar 3 vezes sem digitar.

**BUG-07 — Antes de existir sessão, escolher ambiente ou modo do agente não faz nada.**
- Onde: `App.tsx:1018` (`changeEnvironment`: `if (!id) return`) e `:1031` (`changeMode`); `Composer.tsx:946-954` e `:612` mostram os controles mesmo sem sessão. `createSession` cria com modo derivado da superfície (`:335`) e sem ambiente.
- Reproduzir: Code sem sessão → ambiente "WSL" → enviar mensagem → o rodapé volta a "Local".

**BUG-08 — `ErrorBoundary` da área de trabalho não reseta ao trocar de página.**
- Onde: `App.tsx:1800` (`resetKey={activeSessionId ?? surface}` ignora `page`). Se `ArtifactsPage` quebrar, navegar para outra página pela sidebar mantém o fallback até clicar em "Tentar de novo" (e este remonta a página que quebrou).

**BUG-09 — Configurações: edições não salvas são apagadas por qualquer mudança em `settings`; fechar pelo fundo descarta sem aviso.**
- Onde: `SettingsDialog.tsx:203-277` (efeito em `[open, settings]` refaz **todo** o estado local, zera `keyDrafts`, erros e notas); `:521` (`onMouseDown` no backdrop fecha). Eventos `settings_changed` (`App.tsx:457-462`), Composer→permissão, MCP OAuth etc. mudam `settings` com o diálogo aberto.
- Reproduzir: abrir Configurações → MCP, editar o JSON; disparar uma mudança externa (ex.: `window.forja.app.updateSettings({ theme: 'light' })` no console) → o JSON editado volta ao anterior. Clicar fora do diálogo com edições: fecha sem confirmar.

**BUG-10 — Editor de artefatos: sem Ctrl+S, fechar descarta alterações, a seleção se perde ao trocar de projeto.**
- Onde: `ArtifactStudio.tsx:103` (`keymap.of([])`), `:235` (botão Fechar sem guarda de `dirty`), `MorePages.tsx:125-128` (`setSelected(null)` ao trocar de projeto).

**BUG-11 — Página de Artefatos: corrida de carregamento, teto de 200 e profundidade.**
- Onde: `MorePages.tsx:44-63` (sem cancelamento: a resposta antiga de outro projeto pode sobrescrever `nodes`), `:73` (`slice(0,200)` e o contador `files.length` vs banner `nodes.length` em `:145,163`), `:52` pede profundidade 5 mas `index.ts:1846-1850` limita a 4 (`Math.min(4, …)`).
- Evidência: `openclod-artifacts.png` ("667 artefato(s)… 200 arquivo(s)").

**BUG-12 — Cowork: `<select>` de aprovação sem opção para `readonly`/`accept-edits` e escopo global.**
- Onde: `CoworkView.tsx:171-181` (3 `<option>`), valor vem de `settings.policy.mode`. O modo é global: mudar no composer de uma sessão muda todas e as tarefas agendadas (`Composer.tsx:572-579` → `App.tsx changePermission` → `saveSettings({policy})`).

**BUG-13 — Nomes de permissão contraditórios.**
- "Ultrarrestrito" (`Composer.tsx:41`, `CoworkView.tsx:179`, `SettingsDialog.tsx:84`) rotula o modo `unrestricted`, **o mais permissivo** ("Sem bloqueios do harness"); "ultra restrito" lê-se como o oposto. O modo `auto` é "Ignorar permissões" no composer, "Automático" em Configurações (`:77-79`) e "Aprovar automaticamente" no Cowork; no Claude "Automático" e "Ignorar permissões" são modos diferentes.

**BUG-14 — Grafo de memória sem teto de nós: O(n²) por quadro.**
- Onde: `MemoryGraph.tsx:106-152` (160 quadros de `requestAnimationFrame` com repulsão par a par e `setPositions` em React), `core/memory/graph.ts` não limita nós. Projeto Uracan tem 1.934 notas (`openclod-artifact-editor.png`, tabela do Painel).
- Reproduzir: Memória → projeto grande → Grafo; medir congelamento.

**BUG-15 — Nenhuma lista virtualizada.** `Transcript.tsx:467` (histórico inteiro, cada `Markdown` reanalisa/higieniza a cada mudança de texto; durante o streaming `Markdown` do texto parcial roda `marked + DOMPurify` a cada delta), `Sidebar.tsx:349-353`, `MemoryPage.tsx:418`, `ChangesPane.tsx:~85` (até 2 MB de diff = dezenas de milhares de nós, `core/git/service.ts:37`), `ToolCard.tsx:129-138` (`<pre>` sem teto).

**BUG-16 — Links do chat não funcionam.**
- Onde: `index.ts:1033-1040` só abre `https://` ao navegar; links `http://…` (por exemplo `http://127.0.0.1:31415/v1` na conversa de `Prints/image copy 10.png`) e relativos (`GAP_ANALYSIS.md`) são bloqueados sem aviso. Caminhos de arquivo no texto não abrem o painel Arquivos (no Claude, "Clique em um caminho de arquivo na conversa", `image copy 17.png`); não há `onOpenFile` no renderer.

**BUG-17 — Sem menu de contexto e sem zoom.**
- Onde: `Menu.setApplicationMenu(null)` (`index.ts:2239`) e nenhum handler `context-menu` em `src/main` nem no renderer (só `onContextMenu` em sessões/projetos). Botão direito em textarea/input/terminal não oferece Colar/Copiar; Ctrl +/− provavelmente não faz zoom (sem menu nativo não há accelerator de zoom; **confirmar ao vivo**), embora `SettingsDialog.tsx:963-964` mande "usar Ctrl + + / Ctrl + −".

**BUG-18 — Rascunho perdido.**
- Onde: `App.tsx:1370` (`key` do `Composer` muda a cada sessão). Digitar, clicar em outra sessão e voltar descarta texto/anexos. Também no primeiro envio: `send → createSession → openSession` remonta o `Composer`; se `sessions.send` falhar (provedor sem chave), o texto já foi descartado.

**BUG-19 — Fila restaurada é enviada sozinha ao abrir a sessão.**
- Onde: `App.tsx:991-1007` (restaura `inbox` com `origin:'ui'`) + `:970-988` (drena quando `runState` é `idle`): mensagens "na fila" de uma execução anterior do app são reenviadas assim que a sessão abre, sem confirmação.

**BUG-20 — Terminal: Ctrl+C com seleção envia SIGINT; sem copiar ao selecionar.**
- Onde: `TerminalPane.tsx:43-51` (nenhum `attachCustomKeyEventHandler`/`copyOnSelect`); `:69-74` o `.then` do `snapshot` não trata falha (`ready` fica falso e o terminal para de escrever).

**BUG-21 — Painel de contexto usa números inventados.**
- Onde: `SessionPanel.tsx:280-281` (`system: 1100`, `skills: 320` fixos) e `:261-284` (estimativa `length/4`). O Claude mostra categorias medidas (`image copy 11.png`). Viola "Não invente resultados".

**BUG-22 — Reabrir uma sessão em execução mostra "ocioso" e perde stream/ferramentas.**
- Onde: `App.tsx:57-59,265` (`normalizeState` troca estados ocupados por `idle`), `:463` descarta eventos de outras sessões (inclusive `text_delta`, `tool_start`), e `applySession` zera `streaming/tools`. O composer mostra "Enviar" em vez de "Parar" enquanto o ponto da sidebar diz "Trabalhando". **Confirmar ao vivo.**

**BUG-23 — Largura do painel não é limitada pela janela.**
- Onde: `App.tsx:84-95` (limites 280–1400, `SessionPanel.tsx:63-64`) com janela mínima de 1060 px (`index.ts:986-988`): painel de 600 px + sidebar deixa o chat com 160–212 px; a largura persiste em `localStorage` (`forja.panel.layout`).

**BUG-24 — Fechar a janela com um turno em andamento não pede confirmação; o renderer travado não é recuperado.**
- Onde: `index.ts:1060-1066` (`close` → `cleanup` → `destroy`), `index.ts:1048-1050` (`render-process-gone` só loga).

### P2

- **BUG-25** `MenuPopover` sem navegação por setas nem retorno de foco (`Chrome.tsx:93-140`); `context-anchor` sem recorte à viewport (`styles.css:5824-5827`, `Sidebar.tsx:534` usa `y - 190` fixo).
- **BUG-26** Acessibilidade e contraste: ver X04/X05 (`--text-3` claro 3,4:1).
- **BUG-27** `Esc` dispara duas ações: `DictationHost.tsx:169-174` e `App.tsx:683-696` (para o ditado e fecha o painel); `Esc` em Configurações fecha o diálogo mesmo com um popover aninhado aberto.
- **BUG-28** `ArtifactStudio.tsx:166-201` recarrega o iframe a cada tecla; CSV truncado em 200 linhas sem aviso (`:55`).
- **BUG-29** Código morto/duplicado: `lib/useDictation.ts` (não importado), `.modal-tabs` (`styles.css:3994-4018`), blocos `@media` duplicados (`styles.css:5415/6949`), `scripts/ui-shots.cjs` com seletor órfão.
- **BUG-30** Textos: `App.tsx:1256` (caminho `%APPDATA%\Openclod Desktop\skills` incorreto; o real é `%APPDATA%\Openclod\skills`), `App.tsx:1178` (`.forja.json`), `RewindDialog.tsx:45` ("Arquivos alterados não são revertidos") contradiz a opção de restaurar checkpoint (`:54-57`), `SettingsDialog.tsx:916` ("A prévia muda imediatamente ao salvar"), `CLAUDE.md` cita atalho padrão que a migração removeu.
- **BUG-31** Flash escuro para usuários do tema claro (`App.tsx:415-419`; `index.html` sem script de tema).
- **BUG-32** 13 usos de `window.confirm` (nativo, não temático e bloqueante): `App.tsx:1467`, `Sidebar.tsx:176,210,222`, `ProjectsPage.tsx:59,69`, `ScheduledPage.tsx:375`, `CustomizePage.tsx:582`, `FilesPane.tsx:300,324`, `MemoryPage.tsx:140`, `RewindDialog.tsx:71`, `SettingsDialog.tsx:1727`, `WorktreeDialog.tsx:84`.
- **BUG-33** Controles sem efeito: `CoworkView.tsx:106,182,191`; abas de Design `MorePages.tsx:260-262`; toggle Meus/Descobrir em Skills/Plugins/Agentes `CustomizePage.tsx:294-302`; cartões "Sessões recentes" não clicáveis `MorePages.tsx:219-226`; "Notificações móveis" `checked disabled` `:306`; "Conversas arquivadas" estática `:366-368`.
- **BUG-34** Pointer capture sem `pointercancel` (`SessionPanel.tsx:127-145`); `relativeTime` não atualiza sem re-render (`lib/format.ts:119-125`); comentários de diff ancoram no **índice da linha** do diff (`ChangesPane.tsx:~96-110`) e se desalinham quando o arquivo muda.
- **BUG-35** Arrastar e soltar fora do composer é ignorado; ditado pré-aquece um modelo de ~1 GB 1,2 s após abrir (`DictationHost.tsx:196-203`).

---

## 3. Melhorias recomendadas

### P0 (corrigir antes de novas telas)

| ID | Mudança | Arquivos | Critério de pronto |
|---|---|---|---|
| I01 | Reidratar aprovações/perguntas/orçamento pendentes por sessão (expor via IPC o `pending` do orquestrador), mostrar em sessões de segundo plano, badge na sidebar e notificação | `src/renderer/src/App.tsx` (`applySession`, handler de eventos), `src/main/orchestrator.ts` (`pending`, `approvalsFor`), `src/main/index.ts`/`src/preload/index.ts`/`src/shared/api.ts` (coordenar com a sessão que os edita), `Sidebar.tsx` | T26/T27 do roteiro passam; teste unitário do reducer; novo `scripts/ui-approvals.cjs` verde |
| I02 | Não abortar turno ao mudar modelo/modo/esforço/ambiente: desabilitar controles com `busy` e/ou aplicar no próximo turno (toast "vale a partir do próximo turno") e rejeitar no main se `runner.busy` | `Composer.tsx:592-604,837,948`, `orchestrator.ts:845-870` | T18: o turno termina normalmente; teste Vitest de `setModel` com runner ocupado |
| I03 | `saveSettings` só corrige o modelo da sessão se ele não existir mais no provedor | `App.tsx:1139-1152` | T17: modelo escolhido sobrevive a mudar permissão/tema |
| I04 | Separar `.artifact-preview` (miniatura do card) de `.artifact-studio-preview` e dar altura total ao painel | `styles.css:9857,10800`, `MorePages.tsx:220`, `ArtifactStudio.tsx:245` | Captura do editor com preview ≥ 540 px nos modos Dividido e Preview; slides idem |
| I05 | Trocar `window.prompt` por diálogo próprio (campo mascarado para segredos) e `window.confirm` por `ConfirmDialog` temático; regra ESLint `no-restricted-globals` | `CustomizePage.tsx:158`, `SettingsDialog.tsx:1704`, os 13 `confirm` | T52/T58 passam; `grep window.prompt` vazio |

### P1

| ID | Mudança | Arquivos | Critério de pronto |
|---|---|---|---|
| I06 | Sessão preguiçosa: "Criar"/Ctrl+N/"+" abrem composer em branco e só criam no 1º envio; varredor de sessões vazias antigas | `Sidebar.tsx:379-396`, `App.tsx` (`createSession`, Ctrl+N), `core/session/store.ts` | T04: 3 cliques em Criar ⇒ 0 sessões novas na lista |
| I07 | Cartão de "Nova sessão" (ambiente, pasta, worktree) que valha antes da sessão existir | `App.tsx:1018,1031,1676-1711`, `Composer.tsx` | T21b: ambiente WSL escolhido antes do envio persiste na sessão |
| I08 | Configurações com estado "sujo": não resetar quando `settings` muda se houver edição; confirmar ao fechar (backdrop/Esc/Fechar); avisar conflito | `SettingsDialog.tsx:203-277,521` | T60–T62 passam |
| I09 | Permissão **por sessão** e rótulos unificados (ex.: `unrestricted` ⇒ "Sem restrições"; `auto` ⇒ um só nome) | `Composer.tsx:36-50`, `CoworkView.tsx:171-181`, `SettingsDialog.tsx:72-88`, `core/security/permissions.ts` | Mesmo vocabulário nas 3 telas; trocar numa sessão não altera outra; Cowork mostra o valor real |
| I10 | Virtualização/paginação: Transcript (janela), Sidebar, Memória, Artefatos (paginar além de 200), diff (colapsar), grafo (teto + agrupamento) | `Transcript.tsx:467`, `Sidebar.tsx`, `MemoryPage.tsx:418`, `MorePages.tsx:73`, `ChangesPane.tsx`, `MemoryGraph.tsx`, `core/memory/graph.ts` | T90–T95: 3.000 mensagens abrem < 1 s, 60 fps ao rolar; grafo de 2.000 nós sem congelar > 200 ms |
| I11 | Menu de contexto nativo (recortar/copiar/colar/selecionar tudo/ortografia), zoom Ctrl +/−/0, menu de aplicativo completo (Arquivo/Editar/Visualizar/Ir/Ajuda) com Ctrl+W, Ctrl+Shift+T, Ctrl+U, Ctrl+F, Ctrl+; | `src/main/index.ts` (coordenar), `App.tsx:658-698`, `Chrome.tsx` | T70–T78 passam |
| I12 | Links: abrir `http(s)` externo, caminhos de arquivo no chat abrem o painel Arquivos | `src/main/index.ts:1033-1040`, `Markdown.tsx`, `Transcript.tsx`, `FilesPane.tsx` | T34: clicar em `src/App.tsx:10` abre o arquivo no painel; link http abre no navegador padrão |
| I13 | Rascunho por sessão (memória + `localStorage`) e preservar o texto se o 1º envio falhar | `App.tsx:1370`, `Composer.tsx:192-200` | T20/T21 passam |
| I14 | `ErrorBoundary` com `resetKey` incluindo `page`; boundary raiz; `render-process-gone` ⇒ recarregar + aviso | `App.tsx:1800`, `main.tsx`, `index.ts:1048` | T110–T112 passam |
| I15 | Editor de artefatos: Ctrl+S, guarda de alterações, debounce do preview, aviso de CSV truncado | `ArtifactStudio.tsx:103,166-201,235` | T45–T47 passam |
| I16 | Painel de contexto com medições reais por categoria (usar o uso do provedor/estimador do runner) | `SessionPanel.tsx:261-284`, `core/agent/context.ts` | Sem constantes fixas; soma = total mostrado |
| I17 | Terminal: Ctrl+C com seleção copia, Ctrl+Shift+V cola, "copiar ao selecionar", menu de cursor e scrollback | `TerminalPane.tsx:43-51,181-197` | T40–T42 passam |
| I18 | Limitar a largura do painel a `janela − sidebar − 360 px` | `App.tsx:84-95`, `SessionPanel.tsx:63-64,127-145` | T100: a 1060 px o chat nunca fica < 360 px |
| I19 | Não auto-enviar fila restaurada: mostrar chips e pedir "Enviar agora" | `App.tsx:970-1007` | T31b |
| I20 | Refletir `busySessions` e restaurar streaming/ferramentas ao reabrir sessão em execução | `App.tsx:57-59,265,463`, `orchestrator.ts` (snapshot parcial) | T28 passam |

### P2 (paridade de telas e polimento)

| ID | Mudança | Arquivos | Critério de pronto |
|---|---|---|---|
| I21 | **Novidades** (release notes por versão, modal) e **Apps e extensões** | novo componente + `Sidebar.tsx`/`Composer.tsx` | Modal abre pelo link "Novidades" da barra superior do Code |
| I22 | Projetos: modal "Criar um projeto" (nome, objetivo, pasta), menu Fixar/Editar/Arquivar | `ProjectsPage.tsx`, `App.tsx addProject`, `shared/types` | `M18`/`M19` ✅ |
| I23 | Artefatos como galeria: abas Todos/Meus, ordenar, grade/lista, menu por item, miniaturas, "Criar algo novo" real | `MorePages.tsx` | `M20`–`M22` ✅ |
| I24 | Design: galeria real (artefatos HTML do tipo design), abas funcionais | `MorePages.tsx:247-273` | Abas filtram; sem controles inertes |
| I25 | Skills: Descobrir (catálogo), editar/remover/desativar, upload de `SKILL.md`/`.zip`, "criar com o agente" | `CustomizePage.tsx:294-352` | `M38`–`M40` ✅; toggle Meus/Descobrir sem efeito eliminado |
| I26 | Configurações: busca, grupos "Este computador/Personalização", seções Conta, Privacidade, Uso (limites), Tempo e foco, Extensões `.mcpb/.dxt`, Chrome (sites), Sistema (inicialização, bandeja, armazenamento) | `SettingsDialog.tsx` (dividir em arquivos por aba) | 18/18 seções com equivalente 🟡 ou ✅ |
| I27 | Tema "Sistema" + script de tema antes do React (sem flash) | `styles.css`, `index.html`, `App.tsx:415-419` | T103: reload no tema claro sem flash escuro |
| I28 | Acessibilidade: `aria-label` nos botões de ícone, `MenuPopover` com setas/foco/retorno, focus trap nos diálogos, `role=status` nos toasts, tokens de contraste (`--text-3`) | `Chrome.tsx`, `styles.css:20-66`, todos os diálogos | `axe-core` sem violações sérias/críticas; contraste ≥ 4,5:1 em ambos os temas |
| I29 | Dispatch: caixa de entrada própria e controles reais (ou remover os fictícios) | `MorePages.tsx:283-344` | Sem checkbox `checked disabled` |
| I30 | Limpeza: remover `useDictation.ts`, `.modal-tabs`, `@media` duplicados; atualizar `scripts/ui-shots.cjs`; `relativeTime` com tick; corrigir textos (BUG-30); `spellCheck` pt-BR opcional | vários | `grep` sem restos; `ui-shots.cjs` verde |
| I31 | Cowork: ícone de informação com popover, "Limpar ativo" real, remover botão sem handler | `CoworkView.tsx:106,182,191` | `M12`–`M14` ✅ |
| I32 | Agendados: "Criar com o agente" | `ScheduledPage.tsx:381-392` (arquivo em edição por outra sessão: coordenar) | Item no menu cria tarefa a partir de linguagem natural |

---

## 4. Roteiro de teste ao vivo para o orquestrador

Preparação (T00): subir o Electron como `scripts/ui-work.cjs:84` faz, com **perfil e projetos descartáveis**:
`electron . --remote-debugging-port=9333 --user-data-dir=<tmp>`, `FORJA_MOCK_SCRIPT=<arquivo>` para turnos roteirizados
(`src/core/providers/index.ts:20-26`), janela 1440×900 (`scripts/ensure-1440.cjs`), dois projetos git descartáveis
(um com ≥ 250 arquivos `.md`, outro com 2.000 notas de memória). Conectar por CDP (`playwright-core`,
`chromium.connectOverCDP('http://127.0.0.1:9333')`) coletando `pageerror` e `console.error` durante todo o roteiro.
Cada passo: **Ação** → **Esperado**. `[prever falha: BUG-xx]` = o código sugere defeito; registrar o que ocorrer.

### A. Início, sidebar e navegação

| # | Ação | Resultado esperado |
|---|---|---|
| T01 | Abrir o app limpo | Aba Início ativa; saudação "Olá, …"; banner "Nenhum provedor real configurado" (Scripted); placeholder "Como posso ajudar você hoje?"; sidebar com 9 itens (Projetos, Memória, Artefatos, Agendados, Atividades, Dispatch, Design, Personalização, Mais); 0 erros de console |
| T02 | Configurações → Aparência → nome "Maike" → Salvar alterações | Início passa a mostrar "Olá, Maike" sem recarregar |
| T03 | Clicar em "Cowork" no composer | Tela "O que vamos realizar hoje?", seletor de projeto, seletor de aprovação, "Em andamento" só se houver sessões Cowork |
| T04 | **[prever falha: BUG-06]** Clicar 3× em "Criar" e apertar Ctrl+N 2× | Esperado (Claude): nenhuma sessão nova até enviar. Registrar quantas "Nova sessão" aparecem em "Conversas e tarefas" |
| T05 | Lupa → digitar parte de um título → Esc | Lista filtra por título/prévia; Esc fecha a busca e limpa |
| T06 | Botão de filtro | Alterna "Mais antigas primeiro/Mais recentes primeiro"; lista limitada a 60 itens (criar 70 sessões por script e confirmar o corte sem "ver mais") |
| T07 | Clicar Code → Início → Code | Cada troca limpa a sessão (`onMode`); confirmar que o painel lateral fecha e a sessão ativa não é restaurada |
| T08 | Voltar/Avançar na barra de título depois de abrir 3 sessões | Reabre as sessões na ordem do histórico; botões desabilitam nos extremos |
| T09 | Menu ☰ | Popover com Nova sessão (Ctrl+N), Abrir pasta, Importar sessão, Configurações (Ctrl+,) e linha "Atalhos…" desabilitada; **não** há Arquivo/Editar/Visualizar/Ir/Ajuda (registrar ❌) |

### B. Composer

| # | Ação | Resultado esperado |
|---|---|---|
| T10 | Digitar `/` | Menu com 8 comandos + skills; ↑↓ navegam; Enter/Tab executam; Esc limpa o texto |
| T11 | `/tema` | Alterna claro/escuro e salva; `/xyz` não abre menu; `/novo a` (com espaço) vira texto normal |
| T12 | Digitar texto e Ctrl+Enter | Mensagem vira chip "Na fila (1)"; "x" remove; ícone de envio injeta no turno |
| T13 | Anexar: arquivo `.txt` pequeno, imagem colada (Ctrl+V), pasta (menu +), 9º anexo | Chips com tamanho/tipo; 9º mostra "Máximo de 8 anexos"; imagem > 12 MB sem caminho mostra erro |
| T14 | Arrastar arquivo para o composer e para fora dele | Realce `is-drag` no composer; fora do composer nada acontece (registrar P2) |
| T15 | Menu de modelo → buscar "gpt" → escolher | Lista filtrada; rótulo muda; reiniciar o app mantém o modelo (`lastModel`) |
| T16 | Menu de esforço com provedor Scripted | Mensagem "Este modelo não expõe esforço de raciocínio" (desabilitado) |
| T17 | **[prever falha: BUG-03]** Provedor com 2 modelos: escolher o não padrão numa sessão, depois mudar a permissão no composer | O modelo deve permanecer; previsto voltar ao padrão |
| T18 | **[prever falha: BUG-02]** Turno longo (ferramenta `sleep`): abrir menu de modelo e escolher outro | O turno deve continuar; previsto "cancelado" sem aviso |
| T19 | Clicar no microfone (modelo falso do `ui-mic-pill.cjs`) | Pílula aparece, texto ditado é inserido no caret; Esc para (confirmar se o painel lateral também fecha: BUG-27) |
| T20 | **[prever falha: BUG-18]** Digitar 3 linhas, clicar em outra sessão e voltar | Rascunho deveria permanecer; previsto vazio |
| T21 | **[prever falha: BUG-18]** Provedor sem chave: enviar a 1ª mensagem do Início | Erro claro e **texto preservado**; previsto texto perdido e sessão vazia criada |
| T21b | **[prever falha: BUG-07]** Code sem sessão: escolher ambiente WSL no rodapé e enviar | A sessão nasce em WSL; previsto "Local" |
| T22 | Enter durante turno em andamento | Vai para a fila (placeholder "Digite para adicionar à fila…"); botão ■ para o turno |

### C. Sessão: aprovações, perguntas, fila, plano

| # | Ação | Resultado esperado |
|---|---|---|
| T25 | Modo "Perguntar" + script que chama `run_command` | `ApprovalDock` com título, risco, efeito, comando; "Negar" com motivo envia feedback ao agente; "Aprovar" executa; "Permitir sempre" não pergunta de novo nesta sessão |
| T26 | **[prever falha: BUG-01]** Com a aprovação pendente, abrir outra sessão e voltar | O cartão deve reaparecer; previsto vazio e agente travado até "tempo de aprovação esgotado" (5 min) |
| T27 | **[prever falha: BUG-01]** Tarefa agendada ou sessão A em segundo plano pede aprovação enquanto a janela está em B | Aviso na sidebar/notificação; previsto nada |
| T28 | **[prever falha: BUG-22]** Reabrir uma sessão com turno em andamento | Botão "Parar" visível e stream continua; previsto "Enviar" e texto parcial perdido |
| T29 | Ferramenta `ask` (perguntas) → responder e pular | `QuestionDock` aparece, respostas voltam ao agente; "Pular" envia lista vazia |
| T30 | Plano de 3 passos | `PlanDock` "0/3" → "2/3"; clicar no passo abre o painel Plano focado |
| T31 | Duas mensagens na fila e fim do turno | Drenagem automática uma por vez |
| T31b | **[prever falha: BUG-19]** Fechar o app com 1 item na fila, reabrir e abrir a sessão | A fila deve esperar confirmação; previsto envio automático |
| T32 | Estourar orçamento (limite baixo) | `BudgetDock` com "Continuar"; continuar envia "continuar de onde parou" |
| T33 | Título → "Voltar ou ramificar conversa" | Lista de mensagens, filtro, ramificar cria "· lateral"; subtítulo contradiz a opção de restaurar checkpoint (BUG-30) |
| T34 | Escrever no texto do assistente um caminho (`src/App.tsx:10`) e um link `http://localhost:3000` e clicar | **[prever falha: BUG-16]** caminho deveria abrir o painel Arquivos e o link o navegador padrão; previsto nada |
| T35 | Exportar sessão e importar de volta | Arquivo `<título>.forja.json` (BUG-30), importa e abre; título termina em "(importada)" |

### D. Painéis da sessão

| # | Ação | Resultado esperado |
|---|---|---|
| T40 | Terminal → `echo FORJA_TERM_$((6*7))` | Saída `FORJA_TERM_42` (já provado em `ui-panes.cjs`) |
| T41 | **[prever falha: BUG-20]** Selecionar texto no terminal e Ctrl+C | Deveria copiar; previsto enviar ^C |
| T42 | Botão direito no terminal e no composer | **[prever falha: BUG-17]** previsto sem menu |
| T43 | Navegador: `localhost:5174`, "Usar esta", URL inválida | Dev server detectado; `.forja/launch.json` criado; URL inválida mostra o erro inline |
| T44 | Arquivos: abrir, editar, Ctrl+S, alterar o arquivo por fora e salvar | "Salvo"; conflito pergunta "Sobrescrever?" |
| T45 | Artefatos → abrir `.md` → Dividido | **[prever falha: BUG-04]** previsto preview com ~110 px de altura; esperado ≥ 540 px |
| T46 | **[prever falha: BUG-10]** Editar no editor de artefatos e apertar Ctrl+S | Deveria salvar; previsto nada |
| T47 | **[prever falha: BUG-10]** Editar e clicar no X | Deveria pedir confirmação; previsto descartar |
| T48 | Alterações: editar arquivos, adicionar comentário de linha, copiar comentários | Lista/árvore, diff, contagem; comentário aparece na linha |
| T49 | Tarefas em segundo plano: `start_process`, ■ encerrar | Processo aparece em execução e encerra |
| T50 | Painel: maximizar, mover para esquerda, arrastar a borda até 1400 px com janela de 1060 px | **[prever falha: BUG-23]** o chat deve manter ≥ 360 px; previsto espremido |

### E. Páginas

| # | Ação | Resultado esperado |
|---|---|---|
| T51 | Projetos: buscar, ordenar, menu ⋮ (Nova sessão, Worktrees, Explorer, Grafo, Remover, Excluir) | Cada item funciona; Remover/Excluir pedem `window.confirm` (BUG-32); "Novo projeto" abre direto o seletor de pasta (M18 ❌) |
| T52 | Personalização → Conectores → Descobrir → "Adicionar" em conector com `needs` | **[prever falha: BUG-05]** deveria abrir diálogo de credencial; previsto exceção `prompt() is not supported` |
| T53 | Personalização → Skills → "Descobrir", Plugins → "Descobrir", Agentes → "Descobrir" | **[prever falha: BUG-33]** o conteúdo não muda |
| T54 | Criar skill pelo formulário | Cartão novo; arquivo `SKILL.md` na pasta de skills |
| T55 | Plugins: "Instalar pasta local" (fixture de `ui-plugins.cjs`), ativar, desativar, remover | Funciona (já provado) |
| T56 | Artefatos num projeto com ≥ 250 arquivos | **[prever falha: BUG-11]** contador "200 arquivo(s)" vs banner N; sem paginação |
| T57 | Artefatos: trocar de projeto rapidamente 3× | **[prever falha: BUG-11]** a lista final deve ser do último projeto |
| T58 | Memória → página → "Invalidar" | **[prever falha: BUG-05]** previsto erro de `prompt()` |
| T59 | Memória → Grafo no projeto com 2.000 notas | **[prever falha: BUG-14]** medir bloqueio do thread principal (> 200 ms = falha) |
| T59b | Memória → Exportar, Importar ZIP | Contagem de páginas importadas na nota |
| T59c | Agendados: criar por modelo, "executar agora", pausar, ordenar, apagar | Sessão "Agendada: …" criada; "Criar com o Claude" ausente (M34) |
| T59d | Dispatch e Design | Dispatch: só "Manter computador ativo" muda estado; Design: abas Meus/Compartilhados não respondem (BUG-33) |
| T59e | Atividades | Lista atualiza a cada 2,5 s; filtros funcionam |

### F. Configurações

| # | Ação | Resultado esperado |
|---|---|---|
| T60 | Ctrl+, → percorrer as 10 abas | Todas renderizam sem erro de console; rodapé "Salvar alterações / Fechar" |
| T61 | **[prever falha: BUG-09]** Aba MCP: editar o JSON; no console CDP rodar `window.forja.app.updateSettings({ theme:'light' })` | O texto editado deveria permanecer; previsto voltar ao anterior |
| T62 | **[prever falha: BUG-09]** Editar um campo e clicar no fundo escuro | Deveria perguntar; previsto fechar e perder |
| T63 | JSON inválido em MCP, Hooks e Ambientes | Mensagem de erro e troca para a aba correta; nada é salvo |
| T64 | Trocar o tema no diálogo sem salvar | Prévia só ao salvar (texto da tela diz o contrário: BUG-30); salvar aplica |
| T65 | Provedores: adicionar preset, remover último provedor, salvar chave, testar, detectar modelos | Não remove o único provedor; chave vai ao cofre; teste mostra detalhe |
| T66 | Voz, Backup, Diagnóstico, Sobre/updater | Os roteiros `ui-tts`, `ui-backup`, `ui-diagnostics`, `ui-updater` continuam verdes |
| T67 | Permissões: trocar modo e verificar Composer, Cowork e Configurações | **[prever falha: BUG-12/13]** Cowork deve refletir `accept-edits`; nomes iguais nas 3 telas |
| T68 | Notificações: silêncio 22:00–07:00 | Persistido (`ui-notifications.cjs`) |

### G. Menus, atalhos e janela

| # | Ação | Resultado esperado |
|---|---|---|
| T70 | Ctrl+B, Ctrl+N, Ctrl+, , Ctrl+Shift+E | Alterna sidebar; cria sessão (BUG-06); abre Configurações; exporta |
| T71 | Ctrl+W, Ctrl+Shift+T, Ctrl+U, Ctrl+F, Ctrl+; | Previsto sem efeito (M91/M92) |
| T72 | **[prever falha: BUG-17]** Ctrl + "+", Ctrl + "−", Ctrl+0 | Deveria dar zoom (a tela promete); previsto sem efeito |
| T73 | Ctrl+Alt+F com a janela minimizada | Restaura e foca |
| T74 | F12 / Ctrl+Shift+I | Abre/fecha DevTools |
| T75 | Alt | Sem menu nativo (`Menu.setApplicationMenu(null)`) |
| T76 | Duplo clique na barra de título; arrastar; Win+←/→ | Maximiza/restaura; arrasta; encaixa |
| T77 | Segunda instância do executável | Foca a janela existente (`requestSingleInstanceLock`) |
| T78 | **[prever falha: BUG-24]** Fechar a janela com turno em execução | Deveria avisar; previsto encerrar direto |

### H. Teclado e acessibilidade

| # | Ação | Resultado esperado |
|---|---|---|
| T80 | Navegar só com Tab/Shift+Tab em Início, sessão, Configurações | Anel de foco visível em todo controle (`:focus-visible`); ordem lógica |
| T81 | Abrir qualquer `MenuPopover` e usar ↑/↓ | **[prever falha: BUG-25]** deveria navegar; previsto só Tab; Esc fecha e o foco deve voltar ao botão |
| T82 | Dentro do diálogo de Configurações, Tab repetido | Foco deve ficar preso no modal; previsto escapar para a página |
| T83 | Injetar `axe-core` via CDP em Início, sessão, Configurações, Personalização | Relatar violações por regra; esperadas: nomes ausentes em botões de ícone, `aria-hidden` com foco, contraste |
| T84 | Contraste: medir `--text-3` nos dois temas | Esperado ≥ 4,5:1; previsto 3,4:1 (claro) e ≈4,1:1 (escuro sobre `--elevated`) |
| T85 | Leitor de tela (Narrador): ler a sidebar e o transcript | Itens anunciados com nome; ponto "Trabalhando" anunciado; toasts anunciados (`role=status` ausente) |

### I. Responsividade e tema

| # | Ação | Resultado esperado |
|---|---|---|
| T100 | Janela 1060×680 com painel Terminal aberto (largura 600) | **[prever falha: BUG-23]** chat ≥ 360 px |
| T101 | Janela no mínimo e zoom por `Emulation.setPageScaleFactor`/CSS `zoom` 150% e 200% | Layouts de Settings, Projetos, Memória, Slides não quebram; sidebar não colapsa sozinha (registrar) |
| T102 | Alternar tema claro/escuro em todas as páginas (Início, sessão, Settings, Artefatos, Slides, Terminal, Navegador) | Sem texto invisível; terminal (`xtermTheme`) acompanha |
| T103 | Recarregar com tema claro salvo | **[prever falha: BUG-31]** previsto flash escuro antes de aplicar |
| T104 | Windows "reduzir movimento" ativo | Spinners e shimmer ficam estáticos (`styles.css:5401`) |

### J. Erros, desempenho e estado

| # | Ação | Resultado esperado |
|---|---|---|
| T90 | Importar sessão JSON com 3.000 mensagens e abrir | Abre < 1 s, rolagem fluida (**[prever falha: BUG-15]**) |
| T91 | Streaming de 20.000 caracteres via script | Sem queda de quadros; `Markdown` reanalisa a cada delta (medir) |
| T92 | 500 sessões na sidebar (Code, 1 projeto) | Abre/rola sem travar (**[prever falha: BUG-15]**) |
| T93 | Diff de 2 MB no painel Alterações | Abre sem congelar (**[prever falha: BUG-15]**) |
| T94 | Saída de ferramenta com 5 MB no `ToolCard` | Truncada com aviso (**[prever falha: BUG-15]**) |
| T95 | Trocar de sessão 20× rápido durante streaming | Apenas a última sessão fica na tela; sem mensagem de outra sessão misturada (guarda `sessionEpoch`) |
| T96 | Reiniciar o app | Sessões, modelo (`lastModel`), esforço, layout do painel e tema permanecem; rascunhos não |
| T110 | **[prever falha: BUG-08]** Forçar erro em uma página (CDP: sobrescrever `Array.prototype.map` momentaneamente na página Artefatos) e navegar para Projetos | A área deve se recuperar ao trocar de página; previsto fallback preso |
| T111 | Erro em `Sidebar`/`Titlebar` (fora de qualquer `ErrorBoundary`) | Previsto tela inteira em branco (sem boundary raiz) |
| T112 | **[prever falha: BUG-24]** Matar o renderer (`Target.crash`) | O app deve se recuperar; previsto janela morta (só log) |

---

## 5. Apêndice

### 5.1 Atalhos: Claude × Openclod

| Ação | Claude (88–90) | Openclod |
|---|---|---|
| Nova sessão | Ctrl+N | Ctrl+N (cria sessão persistente, BUG-06) |
| Nova sessão em nova janela / conversa lateral | Ctrl+Shift+N / Ctrl+; | ❌ / ❌ (ramificar pelo menu) |
| Abrir arquivo / pasta | Alt+Ctrl+Shift+O / Ctrl+Shift+O | ❌ / sem atalho |
| Configurações | Ctrl+Vírgula | Ctrl+, |
| Fechar sessão / janela / reabrir | Ctrl+W / Ctrl+Shift+W / Ctrl+Shift+T | ❌ |
| Anexar | Ctrl+U | ❌ |
| Desfazer, refazer, recortar, copiar, colar, selecionar tudo | menu Editar | só nativo em campos de texto; sem menu de contexto |
| Localizar | Ctrl+F / F3 / Shift+F3 / "nos arquivos" | ❌ |
| Alternar barra lateral | — | Ctrl+B |
| Exportar sessão | — | Ctrl+Shift+E |
| Painel de arquivos: árvore | Ctrl+Shift+Y | Ctrl+Shift+Y |
| Janela global | Ctrl+Alt+Space (Entrada Rápida) | Ctrl+Alt+F (restaurar janela); ditado por atalho configurável |
| Ditado | Ctrl+D | botão do microfone / atalho configurável (padrão vazio) |
| DevTools | — | F12, Ctrl+Shift+I |

### 5.2 Scripts E2E a criar (lacunas)

`ui-approvals.cjs` (T25–T28), `ui-settings-roundtrip.cjs` (T60–T64), `ui-artifacts.cjs` (T45–T47, T56–T57),
`ui-home-nav.cjs` (T01–T09), `ui-cowork.cjs` (T03, T67), `ui-a11y.cjs` (axe), `ui-perf.cjs` (T90–T95),
`ui-errors.cjs` (T110–T112). Corrigir `ui-shots.cjs` (seletor `.settings-nav`) e dar um perfil descartável ao
`ui-flows.cjs`.

### 5.3 Comparação de arquitetura que explica vários achados

O renderer concentra o estado em `App.tsx` (≈1.930 linhas) e descarta eventos de sessões que não estão na tela
(`App.tsx:463`); por isso aprovações, perguntas, streaming e ferramentas só existem para a sessão ativa
(BUG-01, BUG-22). O orquestrador recria o runner em cada `set*` (`dropRunner`), o que é seguro apenas com o runner
ocioso (BUG-02). `SettingsDialog.tsx` (2.139 linhas) mistura 10 abas em um só estado (BUG-09). A tabela da seção 1
mostra que as telas de maior valor do harness (Terminal, Navegador, Arquivos, Alterações, Tarefas, Worktrees,
Memória, Slides, Plugins) têm E2E; as telas "de vitrine" copiadas do Claude (Design, Dispatch, Artefatos-galeria,
Skills Descobrir) são, em maioria, visuais ou prompt→chat.
