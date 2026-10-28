---
name: docx
description: "Cria e edita documentos Word (.docx) de verdade, no Python embutido do Openclod (python-docx): relatórios, propostas, atas, ofícios, cartas, memorandos, manuais, contratos e currículos, com resumo executivo, tabelas formatadas, gráfico em imagem, listas, cabeçalho e numeração de página. Não precisa de Word nem de Python instalado e nunca precisa de pip. Use SEMPRE que pedirem um documento em Word/.docx, um relatório, ata, proposta ou ofício para entregar, ou para ler/editar um .docx existente, mesmo sem dizer 'docx'. Não use para PDF, planilha, apresentação ou Google Docs."
---

# docx — documentos Word de verdade

Você escreve um script Python curto, o Openclod o roda no **Python embutido** e sai um `.docx` que abre no Word, no LibreOffice e no Google Docs. A biblioteca `openclod_office.docx_report` já cuida da tipografia (fonte, margens, títulos, tabela com cabeçalho e total, rodapé "Página X de Y").

## 1. Antes de começar (sempre, um comando)

```
openclod-office check
```

Tem de terminar em "Tudo pronto". **Não rode `pip`**: as bibliotecas (python-docx, openpyxl, python-pptx, XlsxWriter, Pillow, lxml) já estão no Python embutido, o Cowork recusa essa instalação e instalar pacotes muda o computador do usuário. O `python` do computador pode ser outro ou nem existir: use sempre `openclod-python`. Se `openclod-office` não for reconhecido (fora do app), teste `python -c "import docx"`; se faltar, diga ao usuário o que falta e peça aprovação.

## 2. Caminho rápido: relatório de vendas a partir de um CSV

Se os dados são um CSV com as colunas `mes`, `regiao` e `receita` (e, se houver, `produto` e `unidades`), **um comando gera o relatório inteiro** (resumo executivo, tabela por região com total, gráfico e conclusões):

```
openclod-python "<skill-dir>\receitas\relatorio.py" "<pasta>\vendas.csv" --saida "<pasta>\relatorio-vendas.docx" --titulo "Relatório de vendas" --rodape "<texto exigido pela pasta>" --meta Sul=150000 --meta Sudeste=200000 --conclusao "<conclusão sua>" --conclusao "<outra>"
```

- `--rodape`: o texto que o `CLAUDE.md` da pasta exige em todo documento (vai no rodapé e abaixo do título). `--meta REGIAO=VALOR`: as metas **dos arquivos da pasta** (nunca invente; sem `--meta` a tabela sai sem meta e atingimento). `--conclusao` (repetível): conclusões **suas**, a partir dos números que o comando imprime e das decisões da pasta (atas, reuniões); sem elas saem frases genéricas.
- O comando imprime o caminho e os totais; depois é só conferir (`inspect`, passo 6 do caminho livre) e responder. `--help` lista as opções; se o CSV não tiver as colunas, ele diz quais faltam.
- Outros dados ou outro tipo de documento (ata, proposta, ofício...): siga o caminho livre.

## 3. Caminho livre (outros dados ou outro tipo de documento)

1. **Leia o material**: CSV, textos, `document_extract` para PDF/DOCX/XLSX/PPTX, e as instruções da pasta (`CLAUDE.md`: idioma, texto obrigatório, nomes de arquivo).
2. **Calcule em Python**, a partir dos dados: totais, percentuais, ranking. Nunca escreva um número de cabeça.
3. **Estruture**: título e subtítulo; **Resumo executivo** logo no início (3 a 5 frases: o número que importa primeiro e a conclusão); seções com `heading`; tabela só para o que é tabular; **Conclusões e recomendações** acionáveis no fim. Para decisão: 1 a 2 páginas.
4. **Escreva o script em `%TEMP%\openclod-doc\gerar.py`** (nunca na pasta do usuário) e rode `openclod-python "%TEMP%\openclod-doc\gerar.py"`. `%TEMP%` vale no `run_command` e no começo do caminho do `write_file`. Parta da receita `<skill-dir>\receitas\relatorio.py` (leia com `read_file`; `<skill-dir>` é o `dir=` que o `use_skill` devolveu): resumo executivo, tabela com total, gráfico em imagem e conclusões, lendo um CSV.
5. **Salve só a entrega na pasta do usuário**, com o nome pedido. Imagens e rascunhos ficam no `%TEMP%`; apague o script ao terminar.
6. **Confira antes de dizer que terminou**: `openclod-office inspect "arquivo.docx"` mostra títulos, tabelas (primeiras linhas), imagens, página e **AVISOS**; compare os números com os que você calculou e corrija todo aviso. Para contar páginas ou entregar também em PDF: `openclod-office pdf "arquivo.docx" --out "%TEMP%\openclod-doc"` (precisa do LibreOffice; sem ele o `inspect` basta).

## 4. API — `from openclod_office.docx_report import Report`

| Chamada | O que faz |
|---|---|
| `Report(titulo, subtitle=, author=, byline=, date=, footer=, header=, accent="1F4E79", landscape=False)` | cria o documento (A4, Calibri 11, margens 2,3 cm, rodapé com a página); `byline` é a linha sob o título (no lugar do autor) |
| `heading(texto, nivel=1)` | título de seção (1 a 3) |
| `paragraph(texto, align=, bold=, italic=, size=, color=)` | parágrafo; `**negrito**` vira negrito de verdade |
| `bullets(itens, numbered=False)` | lista; item `("texto", 1)` é subitem; a numerada recomeça em 1 |
| `callout(texto, title=)` | caixa de destaque com barra lateral |
| `table(cabecalho, linhas, formats=, widths_cm=, total=False, caption=)` | tabela; `formats` por coluna: `text int num brl brl0 pct pct0` (números à direita); `total=True` faz da última linha o total |
| `image(caminho, width_cm=14, caption=)` | imagem centralizada com legenda |
| `page_break()` · `save(caminho)` | quebra de página · grava o arquivo |

Formatação pt-BR: `from openclod_office import brl, num, pct` (`brl(1234.5)` = `R$ 1.235`, `pct(0.256)` = `25,6%`). Gráfico para o Word: `from openclod_office.charts import bar_png, line_png` gera um PNG limpo (no `%TEMP%`) que entra com `image()`. `doc.doc` é o `docx.Document` do python-docx para o que a API não cobre.

## 5. Editar um .docx existente

- Trabalhe numa **cópia** (ou salve com outro nome): nunca sobrescreva o original sem pedido. Abra com `docx.Document(caminho)`.
- Para trocar texto sem perder a formatação, altere `run.text`; texto partido em vários runs: ponha tudo no primeiro run e esvazie os outros. Tabelas: `doc.tables[i].cell(r, c)`.
- Alterações rastreadas e comentários não são suportados pelo python-docx: avise o usuário se pedirem.

## 6. Armadilhas

- No `cmd.exe` um comando não tem várias linhas e `cat <<EOF` não existe: grave o script com `write_file` e rode o arquivo (`-c` só para uma linha).
- Markdown não vira Word: só `**negrito**` é entendido nos textos do `Report`; use `heading()` e `bullets()` em vez de `#` e `-`.
- Nada de parágrafos vazios para espaçar nem Enter para mudar de página (`page_break()`).
- Tabela com 7 ou mais colunas: `Report(..., landscape=True)`. Texto longo em célula: encurte.
- Sumário e campos que o Word atualiza (F9) não vêm preenchidos: evite, ou avise.
- Nunca invente dado, fonte ou citação. O que não estiver nos arquivos, pesquise e cite, ou diga que falta.
- Instruções da pasta valem: se pedirem um texto exato (ex.: "Preparado por…"), ponha-o em `footer=` ou no corpo.

## 7. Resposta final

Diga o caminho do arquivo, o que ele contém (seções, tabelas, gráfico), os números-chave, o que você conferiu (`inspect`, PDF) e o que o usuário deve revisar ou decidir. Sem repetir o conteúdo do documento.
