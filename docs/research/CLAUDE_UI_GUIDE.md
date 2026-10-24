# Claude Desktop / Claude Code — guia visual (2026-10-24)

Captura feita na janela real do **Claude Desktop 3.6556.1**, em 1440×900,
com mouse/teclado reais. As imagens estão em
`docs/research/evidence/claude-ui-2026-10-24/` (107 capturas após remover
duplicatas). Nenhuma mensagem foi enviada, nenhum plano foi assinado e nada foi
apagado. O e-mail da conta foi tarjado na captura de compartilhamento.

## Estrutura principal

### Início

- Abas superiores: **Início** e **Code**.
- Sidebar: **Criar**, **Projetos**, **Artefatos**, **Agendados**, **Dispatch
  Beta**, **Design**, **Personalização**, **Mais**.
- Abaixo: **Conversas e tarefas**, com busca e filtro (Tipo, Status, Última
  atividade, Agrupar por, Ordenar por) e lista de conversas.
- Saudação personalizada: “Bem-vindo ao fim de semana, {nome}”.
- Banner de limite de uso com “Obter mais uso” e link de limites compartilhados.
- Compositor: **+**, **Chat/Cowork**, modelo, esforço, microfone e enviar.
- Cowork acrescenta: **Projeto ou pasta** (busca, projetos, novo projeto,
  adicionar pasta), **Auto** (aprovar manualmente/automaticamente/ignorar),
  ícone de informação e **Em andamento** com “Limpar ativo”.

### Code

- Sidebar enxuta: **Criar**, **Artefatos**, **Rotinas**, **Personalização**,
  **Mais** e a lista de projetos com sessões.
- Tela “Nova sessão” com cartão de ambiente, seletor **Escolher ambiente**
  (Local: Este computador, ClearDisk, Mais; Nuvem; Remote Control; WSL; Novo
  ambiente), conversas bloqueadas e compositor.
- Seletor de ambiente permite criar ambiente Local/Nuvem/SSH/Remote Control,
  com nome, “Executar em”, pastas, Worktree e variáveis de ambiente.
- Menus do compositor: modelo (Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5,
  mais modelos e esforço), permissões (Automático, Manual, Aceitar edições,
  Plano, Ignorar permissões), anexos (arquivos, pasta, GitHub, comandos,
  conectores, plugins), comandos `/`.
- Sessão: título com menu, painel lateral, terminal, navegador, pasta,
  worktree, opções; grupos de ferramentas expansíveis; imagens de saída.
- Terminal com menu de cursor, cursor piscante, copiar ao selecionar e
  histórico de rolagem.
- “Novidades” mostra release notes por versão.

### Artefatos e Design

- Artefatos: Todos/Meus/Compartilhados com você; busca, ordenar (proprietário,
  tipo, data, compartilhamento, fixados), grade/lista, adicionar; banner “O
  Claude Design agora está aqui”; cartões Documentos, Apresentação, Design,
  Painel; lista de artefatos com menu por item.
- Editor de documento: título, “Conversar”, painel lateral, histórico,
  compartilhar, abas, tipografia (Headings/Text Serif/Sans), blocos (lista,
  checklist, código, data, divisor, dropdown, headings, lista numerada, citação),
  imagem/tabela/fórmula, texto “Start typing, or ask @Claude to write”.
- Design: mesma estrutura de galeria, cartões Apresentação, Design, Design na
  base de…, Sistema de design; agrupamento por mês; links externos.
- Claude Design standalone: templates Blank, Mobile app design, Slides,
  Document, Wireframe, Animation, UI mockups, Résumé, 3D object, Research,
  HTML email, Color + type pairing; Design system, modelo e enviar.

### Agendados e Dispatch

- Agendados: “Tarefas agendadas”, busca, ordenar por próxima execução, “Nova
  tarefa” (Criar com o Claude / Configurar manualmente), estado vazio e seis
  modelos (resumo diário, triagem de caixa, preparação de reunião, resumo
  semanal, ideias de conteúdo, monitoramento de tópico).
- Dispatch: configurações (manter ativo, notificações móveis, uso do
  computador, permissões de código), saídas, cartão “Trabalhe com o Claude
  direto no seu computador”, conversa com composer e botão de três pontos.

### Personalização

- Abas **Skills / Conectores / Plugins** e segmento **Meus / Descobrir**.
- Busca, filtro/ordenação, **Adicionar** (upload/criar skill, criar com Claude,
  gravar tela; conector personalizado; plugin).
- Destaque “Data” da Anthropic; “Novas Skills”; “Skills mais instaladas”;
  categorias com contagem e “Mostrar todos 57”.
- Conectores “Meus”: Stripe (reconectar), Atlassian MCP, Claude in Chrome,
  ElevenLabs, GitHub, Supabase, Vercel, ComfyUI, Gmail, Windsor.ai; status e
  “Vincular”.
- Plugins “Meus”: Vibe prospecting, Desktop Commander, Design; “Descobrir” com
  Data, Novos plugins, Plugins mais instalados, Categorias.
- Skills “Meus”: Criado por você (memoria-codigo-obsidian, design-pro) e Da
  Anthropic e parceiros (skill-creator, google-workspace, computer-health-check,
  desktop-commander-overview, etc.).

### Configurações

Sidebar: **Geral, Conta, Privacidade, Cobrança, Uso, Recursos, Memória, Design
systems, Reflexão, Tempo e foco, Claude Code, Cowork, Claude in Chrome,
Sistema, Extensões, Desenvolvedor, Skills, Conectores**.

Destaques:

- **Memória**: pesquisar/consultar conversas, gerar memória, incluir temas
  sensíveis, importar memória de outros provedores, exportar memória em ZIP
  Markdown, Profile/Tópicos (Interests, Tooling), campo “Diga ao Claude o que
  mudar”.
- **Claude Code**: classificar estados das sessões, alternar modelos quando uma
  mensagem for sinalizada, aparência do código (Claude Light/Claude Dark).
- **Claude in Chrome**: ativar, permissões de sites, sites bloqueados.
- **Sistema**: versão, executar na inicialização, atalho de entrada rápida
  (Ctrl+Alt+Space), atalho de ditado (Ctrl+D), bandeja, manter computador ativo,
  armazenamento, navegadores conectados.
- **Extensões**: instalar extensões .MCPB/.DXT, explorar extensões, configurações
  avançadas.
- **Desenvolvedor**: servidores MCP locais, editar configuração, documentação.
- **Conta**: foto, nome, como deve ser chamado, trabalho, instruções globais,
  sair de todos os aparelhos, apagar conta, ID da organização.

### Apps e extensões

Modal com Chrome, Microsoft 365 (Excel, PowerPoint), Claude Code (aplicativo
para desktop, terminal), JetBrains, Slack, celular (iOS/Android).

### Menus do aplicativo

- Menu hambúrguer: Arquivo, Editar, Visualizar, Ir, Ajuda.
- Arquivo: nova sessão, nova sessão em nova janela, nova conversa lateral,
  abrir arquivo/pasta, **Configurações (Ctrl+,)**, fechar sessão/janela,
  reabrir sessão fechada, sair.

## O que já foi aplicado no Openclod

1. Sidebar do **Code** agora é enxuta (Criar, Artefatos, Rotinas,
   Personalização, Mais + projetos), como no Claude.
2. Saudação do Início usa **nome do perfil** (Configurações → Aparência) ou o
   horário.
3. Cowork ganhou barra **Projeto ou pasta**, **Aprovar manualmente/automático**,
   ícone de informação e **Em andamento** com “Limpar ativo”.
4. AI-Memory por projeto, com páginas, fixadas, handoffs, busca e abertura da
   pasta.
5. Abas Início/Code com duas colunas iguais e foco discreto.
6. Editores de artefato, Design, Dispatch e Agendados têm estrutura equivalente
   (ainda mais simples que o original).

## Lacunas priorizadas

**P0**
- Importar/exportar memória (ZIP Markdown) e tópicos/perfil.
- Editor de artefatos com blocos ricos (tabela, código, checklist, tipografia)
  e “Conversar” lateral.
- Configurações com seções equivalentes (Sistema, Memória, Extensões,
  Desenvolvedor, Skills, Conectores) e instruções globais.

**P1**
- Seletor de ambiente do Code (Local/Nuvem/SSH/Remote Control/WSL) com Worktree e
  variáveis de ambiente.
- Painel de terminal/navegador com abas e menus completos.
- Galeria de Artefatos/Design com busca, ordenar, grade/lista e menu por item.
- Extensões .MCPB/.DXT e importação de memória de outros provedores.
- Comandos `/` com a mesma lista e descrições.

**P2**
- Apps e extensões (Chrome, Microsoft 365, JetBrains, Slack, mobile).
- Novidades/release notes dentro do app.
- Menu nativo Arquivo/Editar/Visualizar/Ir/Ajuda.
- Templates do Claude Design standalone.

## Índice das capturas

As capturas seguem a ordem de navegação. Use os nomes como referência ao
implementar cada tela.

| Arquivo |
|---|
| `00-home-inicial.png` |
| `01-inicio-chat.png` |
| `02-criar-menu.png` |
| `03-projetos.png` |
| `04-artefatos.png` |
| `05-artefatos-meus.png` |
| `06-artefatos-compartilhados.png` |
| `07-artefatos-todos-voltar.png` |
| `08-artefatos-visao-lista.png` |
| `09-artefatos-menu-ordenar.png` |
| `100-settings-tempo-foco.png` |
| `101-settings-claude-code.png` |
| `102-settings-cowork.png` |
| `103-settings-claude-in-chrome.png` |
| `104-settings-claude-code-scroll.png` |
| `105-settings-sistema.png` |
| `107-settings-desenvolvedor.png` |
| `108-settings-skills.png` |
| `109-settings-conectores.png` |
| `109-settings-skills.png` |
| `10-artefatos-busca.png` |
| `110-inicio-final.png` |
| `110-settings-conectores.png` |
| `111-inicio-cowork.png` |
| `112-cowork-projeto-pasta-menu.png` |
| `113-cowork-auto-menu.png` |
| `114-cowork-info.png` |
| `115-inicio-modelo-menu.png` |
| `116-inicio-esforco-menu.png` |
| `117-inicio-mais-modelos.png` |
| `118-inicio-anexar-menu.png` |
| `11-artefatos-menu-mais.png` |
| `120-inicio-ordenar-conversas.png` |
| `121-projetos-novo-projeto.png` |
| `122-projetos-menu-card.png` |
| `12-artefatos-novo-documento.png` |
| `13-artefatos-documento-editor.png` |
| `14-documento-menu-tab.png` |
| `15-documento-renomear-aba.png` |
| `16-documento-menu-mais.png` |
| `17-documento-conversar.png` |
| `18-documento-compartilhar.png` |
| `19-documento-apos-fechar-chat.png` |
| `20-artefato-abrir-documento.png` |
| `21-artefato-editor-fechado.png` |
| `22-artefatos-retorno.png` |
| `23-artefatos-pagina-inicial-independente.png` |
| `26-artefatos-limpo.png` |
| `27-agendados.png` |
| `28-agendados-nova-tarefa-menu.png` |
| `29-agendados-ordenar-menu.png` |
| `31-dispatch.png` |
| `32-dispatch-permissoes-menu.png` |
| `34-design-galeria.png` |
| `35-design-meus.png` |
| `36-design-compartilhados.png` |
| `37-design-grade.png` |
| `38-design-ordenar.png` |
| `41-personalizacao-conectores.png` |
| `42-personalizacao-conectores-meus.png` |
| `43-personalizacao-adicionar-menu.png` |
| `45-personalizacao-plugins-meus.png` |
| `46-personalizacao-plugins-descobrir.png` |
| `47-personalizacao-skills-meus.png` |
| `48-personalizacao-skills-descobrir.png` |
| `49-personalizacao-adicionar-skill-menu.png` |
| `50-personalizacao-skills-mais-instaladas.png` |
| `51-personalizacao-categorias.png` |
| `52-personalizacao-categorias-todas.png` |
| `53-personalizacao-categorias-lista.png` |
| `54-personalizacao-categorias-fim.png` |
| `56-mais-expandido.png` |
| `59-icone-configuracoes.png` |
| `60-apps-extensoes-scroll.png` |
| `61-apps-extensoes-fim.png` |
| `62-code-nova-sessao.png` |
| `63-code-escolher-ambiente.png` |
| `64-code-ambiente-mais.png` |
| `65-code-novo-ambiente.png` |
| `66-code-modelo-menu.png` |
| `67-code-mais-modelos.png` |
| `68-code-esforco-menu.png` |
| `70-code-permissoes-menu.png` |
| `71-code-anexar-menu.png` |
| `72-code-anexar-conectores.png` |
| `73-code-anexar-plugins.png` |
| `74-code-comandos-barra.png` |
| `75-code-comandos-barra-fim.png` |
| `76-code-novidades.png` |
| `77-code-novidades-scroll.png` |
| `78-code-terminal.png` |
| `79-code-terminal-mais.png` |
| `80-code-terminal-menu.png` |
| `81-code-botao-mais.png` |
| `83-code-projeto-expandido.png` |
| `84-code-sessao-aberta.png` |
| `86-code-sessao-ferramentas-expandidas.png` |
| `88-menu-hamburguer.png` |
| `89-menu-arquivo.png` |
| `90-menu-editar.png` |
| `91-configuracoes.png` |
| `92-settings-conta.png` |
| `93-settings-privacidade.png` |
| `94-settings-cobranca.png` |
| `95-settings-uso.png` |
| `96-settings-recursos.png` |
| `97-settings-memoria.png` |
| `98-settings-design-systems.png` |
| `99-settings-reflexao.png` |
