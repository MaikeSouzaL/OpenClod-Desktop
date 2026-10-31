# Telas no FigCraft entregues em folhas de contato

O Openclod desenha telas de app e de site no **FigCraft** (editor de interfaces, servidor MCP `figcraft`). Depois,
devolve as telas em **folhas de contato**: imagens em grade com várias telas lado a lado, cada uma com o seu código em
cima (`APP-HOM-01`, `APP-HOM-01b`…). É o mesmo jeito de revisar design que o Claude Code usa.

## As peças

| Peça | Onde | O que faz |
|---|---|---|
| Ferramenta `design_sheet` | `src/core/tools/design.ts` | Monta as folhas. Com `figcraft: {}`, ela mesma lê a página atual do FigCraft (`inspect_document`), exporta cada frame de primeiro nível (`export`) na ordem de leitura e monta as folhas. Com `paths`, usa imagens e pastas. Grava `folha-01.png`, `folha-02.png`… e mostra as folhas no chat (ao modelo que enxerga, como imagem). |
| Montagem | `src/core/design/sheets.ts` | Grade com `sharp`: 5 telas por linha e 2 linhas por folha (padrão), célula de 300 px, rótulo de 13 px, título opcional e tema claro ou escuro. Uma tela muito alta (rolagem) é cortada a 2,6 larguras. |
| Skill `design-telas` | `resources/skills/design-telas/SKILL.md` | O método: manual do FigCraft, escolha do documento, design system primeiro, um frame por tela com código, auto layout, estados (vazio, erro, modal…), conferência por screenshot e entrega com `design_sheet`. |

Um pedido como "desenhe as telas do app…" ou "monte as folhas de contato" faz o harness sugerir a skill e a
ferramenta. `design_sheet` fica fora do conjunto enviado em toda requisição: o modelo a carrega pelo nome ou com
`tool_load`.

## Uso

```text
design_sheet {"figcraft": {}, "title": "Prato Feito · Pedido"}          # todos os frames da página atual
design_sheet {"figcraft": {"ids": [12, 40, 41]}, "columns": 3}            # só esses frames
design_sheet {"paths": ["design/exportadas"], "labels": ["LOG-01", "LOG-02"]}
```

As folhas vão para `.openclod/folhas/<data>/` no projeto, ou para `out_dir`. Os PNGs exportados ficam em
`telas/`, ao lado. O texto do resultado lista as folhas e as telas de cada uma; um frame que não exportou vira aviso,
e as demais telas seguem.

## Cuidados

- **O documento certo.** O servidor `figcraft` do usuário costuma rodar com `mcp --attach auto`, ligado ao FigCraft
  aberto. A skill manda o modelo conferir o arquivo (`connect {}`) e não editar um que o usuário não indicou. Sem
  arquivo indicado, ele trabalha sem janela e salva com `save_file`.
- **A qualidade depende do modelo.** O harness dá o caminho: o desenho, a conferência e as folhas. Telas de nível de
  estúdio exigem um modelo forte.

## Verificação

- Testes: `tests/design-sheet.test.ts`, com a grade, a ordem de leitura, a leitura do `inspect_document` e um FigCraft
  falso que exporta PNGs de verdade.
- App real: `node scripts/ui-design.cjs --root <snapshot> --provider <id> --model <modelo>`. Usa perfil descartável
  e o FigCraft **sem janela** (`figcraft-cli mcp`, sem `--attach`), então não toca no FigCraft do usuário. O modelo
  carrega a skill, desenha 4 telas e chama `design_sheet`; o script confere as folhas em disco e desenhadas na
  conversa. Prints e relatório: `Prints/design-folhas-<data>/`.
- Ferramenta alcançável: `tests/tool-reach.test.ts` falha quando uma ferramenta registrada não está em nenhum modo.
  `design_sheet` está nos modos que gravam arquivos; `memory_file`, em todos.

### Rodadas em 30/10/2026 (OpenCode Go)

| Modelo | Resultado |
|---|---|
| `gemini-4-argon` | 7/7 em 5,4 min. Carregou a skill; criou a página de design system e as 4 telas com componentes e instâncias (12 `batch`, 7 `get_node`, 3 `screenshot`); salvou o `.figcraft`; a folha apareceu na conversa. |
| `beam-free` | Rodou antes da correção de `MODE_TOOLS`: não achou `design_sheet` (28 `tool_search`) e parou sem desenhar. |
