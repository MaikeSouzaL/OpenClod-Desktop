# Catálogo do Claude Code (levantamento real)

Captura feita em **2026-10-24** nesta máquina, com o Claude Code **2.1.309**
(`C:\Users\Administrator\AppData\Roaming\npm\claude`). Nenhum segredo é
reproduzido aqui; chaves de MCP e credenciais ficam fora do documento.

## O que está instalado no Claude Code

### Skills globais (`~/.claude/skills`)

| Skill | Para que serve |
|---|---|
| `grill-me` | Interrogar o usuário antes de codar, expondo premissas e decisões. |
| `pdf-entrega-affinitas` | Gerar o PDF de provas/entrega no padrão Affinitas/Urmobo. |
| `pdf-entrega-affinitas-workspace` | Variante da skill anterior para o workspace. |
| `qa-total` | QA completo, com ledger, evidências, gate e relatório. |

### Agentes (`~/.claude/agents`)

90 definições, entre elas: `accessibility-tester`, `ai-engineer`,
`angular-architect`, `api-designer`, `architect-reviewer`, `backend-developer`,
`blockchain-developer`, `build-engineer`, `c- pro`, `cli-developer`,
`cloud-architect`, `code-reviewer`, `context-manager`, `cpp-pro`,
`csharp-developer`, `data-engineer`, `data-scientist`, `database-optimizer`,
`debugger`, `devops-engineer`, `django-developer`, `docker-expert`,
`documentation-engineer`, `embedded-systems`, `error-detective`,
`fastapi-developer`, `fintech-engineer`, `flutter-expert`, `frontend-developer`,
`fullstack-developer`, `game-developer`, `git-workflow-manager`, `golang-pro`,
`graphql-architect`, `java-architect`, `javascript-pro`, `kotlin-specialist`,
`kubernetes-specialist`, `laravel-specialist`, `legacy-modernizer`,
`llm-architect`, `mcp-developer`, `memory-keeper`, `microservices-architect`,
`ml-engineer`, `mlops-engineer`, `mobile-developer`,
`multi-agent-coordinator`, `nextjs-developer`, `node-specialist`,
`orchestrator`, `payment-integration`, `penetration-tester`,
`performance-engineer`, `php-pro`, `postgres-pro`, `product-manager`,
`project-manager`, `prompt-engineer`, `python-pro`, `qa-expert`, `rails-expert`,
`react-native-expert`, `react-specialist`, `refactoring-specialist`, `ruby-pro`,
`rust-engineer`, `scrum-master`, `security-auditor`, `seo-specialist`,
`spring-boot-engineer`, `sql-pro`, `sre-engineer`, `svelte-developer`,
`swift-expert`, `tailwind-specialist`, `task-distributor`,
`technical-writer`, `terraform-engineer`, `test-automator`, `typescript-pro`,
`ui-designer`, `ux-researcher`, `vite-specialist`, `vue-expert`,
`websocket-engineer`, `workflow-orchestrator`.

### Comandos

- `cortex.md` (comando de usuário).

### MCPs configurados no Claude

| Nome | Transporte | Estado observado |
|---|---|---|
| `mercadopago` | HTTP (`mcp.mercadopago.com/mcp`) | precisa de autenticação |
| `appwrite-docs` | stdio (`npx mcp-remote`) | conectado |
| `appwrite-api` | stdio (`uvx mcp-server-appwrite`) | falhou (conexão fechada) |
| `pencil` | stdio (binário do Pencil) | conectado |
| `whatsapp` | stdio (`uv run` no projeto local) | conectado |
| `rea` | stdio (`node scripts/rea.mjs mcp`) | conectado |
| `bridge_gpt` | stdio (`node dist/index.js`) | conectado |
| `affinitas` | stdio (Python local) | conectado |
| `figcraft` | stdio (CLI local) | conectado |

### Plugins instalados

| Plugin | Versão | Escopo |
|---|---|---|
| `huggingface-skills@claude-plugins-official` | 1.0.29 | usuário |
| `playwright@claude-plugins-official` | `c2bdb427` | usuário |
| `claude-mem@maikesouzal` | 13.24.0 | usuário |

### Marketplace oficial

O snapshot completo está em
`resources/catalog/claude-plugins-official.json`:

- **315 plugins** no catálogo `claude-plugins-official`.
- Categorias: desenvolvimento 123, produtividade 69, banco de dados 39,
  monitoramento 22, segurança 18, deploy 9, design 8, automação 3,
  aprendizado 3, localização 2, testes 2, matemática 2, migração 1,
  sem categoria 14.
- 14 plugins externos locais: `asana`, `context7`, `discord`, `fakechat`,
  `firebase`, `github`, `gitlab`, `imessage`, `laravel-boost`, `linear`,
  `playwright`, `serena`, `telegram`, `terraform`.

Plugins oficiais citados nas telas do Claude: `Data`, `Vibe prospecting`,
`Desktop Commander`, `Design`, `Productivity`, `Marketing`, `Engineering`,
`Finance`, `Postiz`, `Plugin Management`.

## O que o Openclod Desktop implementa agora

1. **Catálogo curado de MCPs** (`src/core/mcp/catalog.ts`): Atlassian oficial
   (HTTP + API token), Jira/Confluence local (`uvx mcp-atlassian`), GitHub,
   Context7, Playwright, Chrome DevTools, Desktop Commander, Filesystem,
   Memory, Sequential Thinking, Fetch, Git, Time, SQLite, PostgreSQL,
   Supabase, Brave Search, Firebase, Stripe, Terraform, Serena, MarkItDown,
   Excel, Notion, Linear, Slack, Asana, Sentry, Figma, Vercel, Laravel Boost.
2. **Auto-instalação** pelo agente: `mcp_search`, `mcp_install`, `mcp_servers`.
   O servidor é salvo em `settings.json`, reconectado e as ferramentas
   `mcp__*` entram no próximo passo do mesmo turno.
3. **Registro oficial MCP** como fallback: qualquer servidor publicado em
   `registry.modelcontextprotocol.io` pode ser pesquisado e instalado.
4. **Transportes** stdio, HTTP (Streamable HTTP) e SSE, com headers estáticos
   (`Authorization`, `X-Api-Key`, ...). OAuth interativo ainda não é
   automatizado; nesses casos o agente pede um token ao usuário.
5. **Tela Personalização → Conectores → Descobrir** com busca e instalação.
6. **AI-Memory por projeto** na barra lateral: wiki markdown, páginas fixadas e
   handoffs, compartilhada por todos os modelos e agentes.
7. **Cowork dentro de Início**, com alternância Chat/Cowork no compositor,
   pasta de trabalho, entregáveis reais e as mesmas permissões/auditoria.

## Agentes especialistas do Openclod

Além dos 87 agentes importados do Claude, o Openclod tem um time próprio,
todos usando `model: best` (o melhor modelo liberado no harness):

| Agente | Papel |
|---|---|
| `computer-operator` | Opera o Windows inteiro: PowerShell/cmd, mouse (mover, esquerdo/direito/meio, down/up, arrastar, rolar) e teclado. Pede plano ao `strategist` e conferência ao `verifier`. |
| `strategist` | Planeja antes de agir: inspeciona o ambiente, escolhe ferramentas/comandos, define verificações e riscos. Somente leitura. |
| `verifier` | Verifica de forma adversarial: reproduz, procura falso positivo, testa o inverso e devolve PASS/FAIL com evidência. |
| `web-qa` | Testa aplicações web no navegador real, lendo ARIA/HTML e decidindo clique/preenchimento/seleção conforme a página. |
| `mobile-qa` | Testa Expo/React Native e Android com ADB, Maestro/Detox, `adb shell input`, screencap e logcat. |
| `qa-lead` | QA ponta a ponta com a skill `qa-total`, ledger, evidências, correção autorizada, reteste e gate. |

### Ferramentas de mouse

`computer_mouse_move`, `computer_click` (esquerdo/direito/meio, duplo),
`computer_mouse_button` (down/up), `computer_drag` (com botão) e
`computer_scroll` (com ponto opcional). Coordenadas vêm da última
`computer_screenshot`; pontos fora da imagem são rejeitados e a posição real do
cursor é devolvida após mover.

### Skill `qa-total`

Copiada de `C:\Users\Administrator\Desktop\02 Memoria e Skills\qa-total` para
`resources/skills/qa-total` e instalada em `%APPDATA%\Openclod Desktop\skills`.
Inclui 44 arquivos (scripts Python, templates, referências e workflows) e uma
nota `OPENCLOD.md` com as diferenças de execução. O agente `qa-lead` a carrega
com `use_skill`.

## Lacunas conscientes

- OAuth 2.1 interativo dos conectores oficiais (Notion, Slack, Linear, Sentry,
  Vercel) não está implementado; a instalação aceita token em header.
- Os 315 plugins oficiais são metadados; importar automaticamente skills de
  repositórios remotos ainda não está implementado. Os conectores MCP que eles
  declaram podem ser instalados pelo catálogo.
- `Dispatch` remoto por celular, `Artefatos` e `Design` têm a estrutura visual
  e o fluxo de criação por prompt, mas ainda não um renderizador próprio de
  slides/design.
