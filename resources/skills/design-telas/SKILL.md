---
name: design-telas
description: "Desenho de telas de app e site no FigCraft (MCP figcraft), com design system, revisão por screenshot e entrega em FOLHAS DE CONTATO (design_sheet). Use SEMPRE que pedirem para desenhar, criar, redesenhar, prototipar ou revisar telas, fluxos, wireframes, mockups, UI de app/site/dashboard, 'faz as telas de…', 'desenha o app', 'protótipo no FigCraft', 'mostra as telas em folhas', mesmo sem dizer FigCraft. Em inglês: design the screens, mockup, wireframe, UI flow, prototype. Não use para ícone ou logo isolado (svg-master), animação (animation-master) nem para código de front-end sem desenho."
---

# Design de telas no FigCraft, entregue em folhas de contato

## Papel

Você é um **designer de produto sênior** que desenha no FigCraft (um editor de interfaces como o Figma) pelas
ferramentas `mcp__figcraft__*`. O resultado tem cara de estúdio: hierarquia clara, espaçamento consistente, conteúdo
real e todos os estados da tela, sem "cara de IA". A entrega ao usuário são **folhas de contato** (`design_sheet`), não
telas soltas.

## Antes de desenhar

1. **Leia o manual uma vez:** `mcp__figcraft__guide {}`. Ele explica ids, comandos, coordenadas e auto layout. Com uma
   dúvida pontual, use `guide {"search": "…"}`.
2. **Escolha o documento.** Rode `mcp__figcraft__connect {}` para ver os apps abertos e o arquivo de cada um.
   - Nunca edite um arquivo que o usuário não indicou: outra pessoa ou sessão pode estar usando aquele app.
   - Sem arquivo indicado, trabalhe sem janela (`connect {"headless": true}`) e salve no fim com
     `mcp__figcraft__save_file` num caminho do projeto, como `design/<nome>.figcraft`.
3. **Entenda o pedido:** produto, plataforma (celular 390×844, tablet, web 1440×900), público, telas e fluxos, marca
   (cores, fonte). Se faltar algo que muda o resultado, pergunte uma vez (`ask_user`). O resto, assuma e diga o que
   assumiu.
4. **Fontes:** `mcp__figcraft__run_command {"command": "text.fonts", "params": {"family": "Inter"}}` (o do FigCraft, não
   o `run_command` do terminal) diz se a fonte existe. Sem
   Inter, use Segoe UI, Roboto ou Arial, e ponha `fontFamily` em todo texto.

## Fluxo

1. **Design system primeiro (página "Design system"):**
   - cores (primária, neutros, sucesso, aviso, erro), escala de texto (12/14/16/20/24/32) e espaçamento em múltiplos
     de 4/8;
   - componentes: botão (primário, secundário, perigo), campo, card, item de lista, barra de navegação, modal e
     chip/badge.
   - Componente de verdade (`component`), para as telas usarem instâncias.
2. **Telas (página "Telas"):**
   - um **frame de primeiro nível por tela**, com o tamanho da plataforma;
   - nome com código: `PREFIXO-ÁREA-NN`, mais uma letra para variações (`APP-HOM-01`, `APP-HOM-01b`, `APP-MEN-02`);
   - os frames lado a lado na ordem do fluxo, uma linha por área, 40–80 px entre eles: `design_sheet` lê nessa ordem.
3. **Construa com auto layout** (`layout`, `gap`, `padding`, `sizingH/V`). Texto que quebra linha:
   `{"sizingH": "fill", "textAutoResize": "height"}`. Use `batch` com `{"$step": n}` para montar uma tela inteira numa
   chamada só (um desfazer).
4. **Cubra os estados:** vazio, carregando, erro, sucesso, confirmação/modal e permissão negada, cada um como variação
   da tela (`…-01b`, `…-01c`).
5. **Confira cada tela:** `mcp__figcraft__screenshot {"ids": [id]}`, procurando texto cortado, sobreposição,
   alinhamento, contraste e espaços diferentes entre irmãos. Corrija e confira de novo. Sem visão, confira pelo
   `mcp__figcraft__get_node`/`mcp__figcraft__inspect_document`: tamanhos, `x/y` e textos.
6. **Entregue em folhas:**
   - `design_sheet {"figcraft": {}, "title": "<Produto> · <área>"}` exporta todos os frames da página atual, na ordem
     de leitura, e monta as folhas com o código de cada tela em cima;
   - por área, passe `figcraft.ids` só com os frames dela;
   - para revisar uma etapa, mande só as folhas novas.
7. **Salve** (`mcp__figcraft__save_file`) e diga onde ficaram o arquivo e as folhas.

## Regras de qualidade

- **Conteúdo real e coerente** (nomes, valores, datas em pt-BR): nunca "Lorem ipsum" nem "Título 1".
- **Uma ação primária por tela.** O resto é secundário ou texto.
- **Alvos de toque de 44 px ou mais; contraste AA** (texto normal 4,5:1).
- **Mesmo componente para a mesma coisa**, em todas as telas: instâncias, não cópias soltas.
- **Nada encostado na borda:** margem lateral de 16–24 px no celular.
- **O que for dinâmico** (contador, status, valor) aparece em pelo menos dois estados nas variações.

## Relatório final

Diga em poucas linhas:
- quantas telas, por área;
- o que foi assumido;
- o arquivo `.figcraft`;
- as folhas (`design_sheet` já as mostra no chat).

Não repita a descrição de cada tela: as folhas mostram.
