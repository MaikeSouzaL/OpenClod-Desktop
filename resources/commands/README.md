# Comandos que vêm com o Openclod

Cada `*.md` desta pasta é um comando de barra (`/commit`, `/revisar`…), no mesmo formato do Claude Code: frontmatter
com `description`, `argument-hint`, `allowed-tools` e `model`, e o texto do pedido com `$ARGUMENTS`, `$1`…`$9` e
`@arquivo`. Um comando com o mesmo nome em `%APPDATA%\Openclod Desktop\commands` ou em `.claude/commands` /
`.openclod/commands` do projeto substitui o daqui.

`allowed-tools` **limita** as ferramentas do turno do comando; não aprova nada (cada chamada passa pelo modo de
permissão e pelas regras). `model` só aparece como sugestão: a sessão continua no modelo dela.

Este arquivo (`README.md`) não é um comando: o carregador pula `README.md`.

## Origem

Adaptados e reescritos em português dos comandos colhidos em `resources/harvested/commands` (licenças em
`resources/harvested/LICENSES/`):

| Comando | Baseado em | Licença |
|---|---|---|
| `commit` | opencode `commit.md` e Kilo Code `commit.md` (sem o push) | MIT |
| `revisar` | Goose `default-review-prompt.md` | Apache-2.0 |
| `review-pr` | MCP Python SDK `review-pr.md` (só leitura) | MIT |
| `issues` | opencode / Kilo Code `issues.md` (repositório atual) | MIT |
| `learn` | opencode `learn.md` | MIT |
| `polish` | Qwen Code `polish.md` | Apache-2.0 |
| `buscar-codigo` | Qwen Code `grep-code.md` | Apache-2.0 |
| `rmslop` | opencode / Kilo Code `rmslop.md` | MIT |
| `spellcheck` | opencode `spellcheck.md` | MIT |
| `dependencias` | opencode / Kilo Code `ai-deps.md` (qualquer dependência) | MIT |

Ficaram de fora: os que não são comandos (`qwen.md`, `qwen-2.md`, um comentário de PR), os links quebrados para
`.clinerules` (`release.md`, `hotfix-release.md`), os que só servem para o repositório de origem ou fazem ações
externas sem aprovação (`release-jetbrains.md`, `review-upstream-merge.md`, `translate.md` com o glossário do opencode)
e o `turborepo.md` (depende de uma skill que o Openclod não traz).
