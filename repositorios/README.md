# Repositórios de estudo

Clones locais (rasos, `--depth 1`) dos projetos citados no prompt mestre, feitos em
**2026-10-23** para estudo. Cada pasta é um repositório Git independente, com a
própria licença. Nenhum deles é dependência do Forja: o build (`tsconfig*`,
`vitest.config.ts`, `electron-builder.yml`) não enxerga esta pasta, e
`.gitignore` exclui os clones.

| Pasta | Origem | Commit clonado | Licença (arquivo) | Uso permitido no Forja |
|---|---|---|---|---|
| `cdesktop/` | github.com/cdesktop-ai/cdesktop | `75bd015` (2026-05-19) | Apache-2.0 | reutilizar com aviso de origem; referência de UX e executores |
| `openharness/` | github.com/pokkai/openharness | `1bcdc62` (2026-04-29) | MIT | portar conceitos/código com atribuição |
| `rea/` | github.com/morluto/rea | `1de720e` (2026-10-24) | MIT | ferramenta de análise (MCP/CLI); integrável |
| `opencode/` | github.com/anomalyco/opencode | `0749dec` (2026-10-23) | MIT | portar conceitos/código com atribuição |
| `deepseek-harness/` | github.com/deepseek-ai/deepseek-harness | `22ddee37` (2026-10-23) | MIT | portar conceitos/código com atribuição |
| `open-computer-use/` | github.com/opensymph/open-computer-use | `e551c13` (2026-10-17) | MIT | já integrado como backend opcional |
| `claw-code-local/` | github.com/codetwentyfive/claw-code-local | `f4cc5d7` (2026-04-03) | **sem arquivo LICENSE** | só referência conceitual — não copiar código |
| `Mcp.ComputerUse/` | github.com/tdav/Mcp.ComputerUse | `41f6b5a` (2026-05-21) | **sem arquivo LICENSE** | só referência conceitual — não copiar código |

Observações:

- `claw-code-local` declara MIT no `README.md` e no `Cargo.toml`, mas não tem
  arquivo `LICENSE` na raiz. Tratamos como "todos os direitos reservados" até
  existir um arquivo de licença.
- Os clones são rasos. Para histórico completo:
  `git -C repositorios/<pasta> fetch --unshallow`.
- Para atualizar todos: `for d in repositorios/*/; do git -C "$d" pull --ff-only; done`.
- A análise de cada projeto está em
  [`docs/research/REPOSITORIES.md`](../docs/research/REPOSITORIES.md) e a
  comparação com o Forja em
  [`docs/research/GAP_ANALYSIS.md`](../docs/research/GAP_ANALYSIS.md).
