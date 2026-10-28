---
name: pptx
description: "Cria e edita apresentações PowerPoint (.pptx) de verdade, no Python embutido do Openclod (python-pptx): slides 16:9 editáveis com capa, números em destaque, gráficos nativos, tabelas, tópicos e notas do apresentador. Não precisa de PowerPoint nem de Python instalado e nunca precisa de pip. Use SEMPRE que pedirem uma apresentação, slides, deck, pitch, .pptx, resultado para a diretoria ou reunião, ou para ler/editar uma apresentação existente, mesmo sem dizer 'pptx'. Não use para Google Slides, PDF, relatório em Word ou planilha."
---

# pptx — apresentações PowerPoint editáveis

Você escreve um script Python curto, o Openclod o roda no **Python embutido** e sai um `.pptx` 16:9 que abre no PowerPoint, no LibreOffice e no Google Slides, com **gráficos e tabelas nativos** (editáveis). A biblioteca `openclod_office.pptx_deck` cuida do design: faixa de cor, tipografia, tamanhos de fonte que cabem na caixa, rodapé e "n / N".

## 1. Antes de começar (sempre, um comando)

```
openclod-office check
```

Tem de terminar em "Tudo pronto". **Não rode `pip`**: as bibliotecas já estão no Python embutido, o Cowork recusa essa instalação e instalar pacotes muda o computador do usuário. Use sempre `openclod-python` (o `python` do computador pode ser outro ou nem existir). Se `openclod-office` não for reconhecido (fora do app), teste `python -c "import pptx"`; se faltar, diga ao usuário e peça aprovação.

## 2. Caminho rápido: apresentação de vendas a partir de um CSV

Se os dados são um CSV com as colunas `mes`, `regiao` e `receita` (e, se houver, `produto` e `unidades`), **um comando gera os 5 slides** (capa, números, gráfico nativo, tabela e próximos passos, com notas do apresentador):

```
openclod-python "<skill-dir>\receitas\apresentacao.py" "<pasta>\vendas.csv" --saida "<pasta>\apresentacao-vendas.pptx" --titulo "Resultados de vendas" --rodape "<texto exigido pela pasta>" --meta Sul=150000 --meta Sudeste=200000 --passo "<passo seu>" --passo "<outro>"
```

- `--rodape`: o texto que o `CLAUDE.md` da pasta exige em todo documento (vai na capa e no rodapé dos slides). `--meta REGIAO=VALOR`: as metas **dos arquivos da pasta** (nunca invente; sem `--meta` a tabela sai sem meta e atingimento). `--passo` (repetível): os próximos passos **do caso**, a partir das decisões da pasta (atas, reuniões); sem eles saem passos genéricos.
- O comando imprime o caminho; depois confira com `inspect` (passo 5 do caminho livre) e responda. `--help` lista as opções; se o CSV não tiver as colunas, ele diz quais faltam.
- Outro número de slides ou outro assunto: siga o caminho livre.

## 3. Caminho livre (outros dados ou outro tipo de documento)

1. **Leia o material** (CSV, textos, `document_extract`, reuniões) e as instruções da pasta (`CLAUDE.md`: idioma, texto obrigatório, nomes). Calcule os números **em Python**, nunca de cabeça.
2. **Conte uma história, um recado por slide**: capa → números que importam → gráfico → tabela de apoio → decisões/próximos passos. O **título de cada slide é a conclusão** ("Sudeste lidera com 41%"), não o assunto ("Receita"). No máximo 6 tópicos, de até 12 palavras; o detalhe vai nas **notas do apresentador** (`notes=`).
3. **Escreva o script em `%TEMP%\openclod-pptx\gerar.py`** (nunca na pasta do usuário) e rode `openclod-python "%TEMP%\openclod-pptx\gerar.py"`. `%TEMP%` vale no `run_command` e no começo do caminho do `write_file`. Parta da receita `<skill-dir>\receitas\apresentacao.py` (leia com `read_file`; `<skill-dir>` é o `dir=` do `use_skill`): 5 slides com indicadores, gráfico nativo, tabela e próximos passos. Quantos slides o usuário pediu, tantos você entrega: acrescente ou apague chamadas `deck.*_slide(...)`.
4. **Salve só a entrega na pasta do usuário.** Apague o script ao terminar.
5. **Confira antes de dizer que terminou**: `openclod-office inspect "arquivo.pptx"` lista cada slide (título, o que há nele, notas) e os **AVISOS** (placeholder vazio, texto que pode transbordar, slide sem título, elemento fora da área). Corrija todo aviso. Para ver o total de páginas: `openclod-office pdf "arquivo.pptx" --out "%TEMP%\openclod-pptx"` (precisa do LibreOffice; deve ter uma página por slide).

## 4. API — `from openclod_office.pptx_deck import Deck`

| Chamada | O que faz |
|---|---|
| `Deck(title=, footer=, accent="1F4E79")` · `save(caminho)` | cria 16:9 · grava (põe rodapé e "n / N" em todos menos a capa) |
| `title_slide(titulo, subtitulo, notes=)` | capa em cor cheia |
| `kpi_slide(titulo, [(rótulo, valor, detalhe)], bullets=, notes=)` | até 4 indicadores grandes e, se quiser, a leitura embaixo |
| `chart_slide(titulo, categorias, {"Série": valores}, kind="column", number_format=, insight=[...], notes=)` | gráfico **nativo**: `column bar line stacked pie doughnut`; `insight` põe a leitura ao lado |
| `table_slide(titulo, cabecalho, linhas, formats=, total=False, notes=)` | tabela nativa (`formats`: `text int num brl brl0 pct pct0`) |
| `bullets_slide(titulo, ["tópico", ("tópico", ["sub"])], lead=, notes=)` | tópicos; `lead` é a frase-resumo no topo |
| `two_columns_slide(titulo, esq_titulo, esq, dir_titulo, dir)` | duas colunas de tópicos |
| `image_slide(titulo, caminho, caption=, notes=)` | imagem ajustada ao slide |
| `blank_slide(titulo)` | slide com título real para desenhar à mão (`slide.shapes`, python-pptx) |

`**negrito**` funciona nos textos. Formatação pt-BR: `from openclod_office import brl, num, pct`. `number_format` do gráfico é o do Excel (`'"R$" #,##0'`, `'0%'`). `deck.prs` é a `Presentation` do python-pptx para o resto.

## 5. Editar uma apresentação existente

- Trabalhe numa **cópia**; nunca sobrescreva o original sem pedido. `Presentation(caminho)`; troque texto por `run.text` para manter a formatação; ache o shape pelo `name` ou `has_text_frame`.
- Para reaproveitar o modelo do usuário, use os `slide_layouts` dele, não os do `Deck`.

## 6. Armadilhas

- No `cmd.exe` um comando não tem várias linhas e `cat <<EOF` não existe: grave o script com `write_file` e rode o arquivo (`-c` só para uma linha).
- Cada slide precisa de **título real** (o `Deck` já usa o placeholder de título): é o que alimenta navegação e leitor de tela.
- Nada de placeholder vazio ("Clique para adicionar…"): o `inspect` avisa.
- Texto demais vira parede: se o `inspect` avisar que pode transbordar, corte palavras ou divida o slide. Não use `fit_text` (depende de fontes instaladas).
- Gráfico de barras parte de zero; poucas cores; rótulos de dados ligados; sem 3D.
- Slides de capa e de seção não levam número nem rodapé. Instrução da pasta com texto obrigatório: use `footer=` e/ou a capa.
- Nunca invente dado, fonte ou citação. O que não estiver nos arquivos, pesquise e cite, ou diga que falta.

## 7. Resposta final

Diga o caminho do arquivo, a sequência de slides (uma linha por slide), os números-chave, o que você conferiu (`inspect`, páginas do PDF) e o que o usuário deve revisar (o que veio de suposição). Sem repetir o conteúdo dos slides.
