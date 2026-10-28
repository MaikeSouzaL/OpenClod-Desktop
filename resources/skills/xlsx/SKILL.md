---
name: xlsx
description: "Cria e edita planilhas Excel (.xlsx) de verdade, no Python embutido do Openclod (XlsxWriter e openpyxl): dados formatados, abas Dados e Resumo, FÓRMULAS REAIS (SOMA, MÉDIA, SUMIF, atingimento de meta) e não valores colados, gráficos nativos, formatação condicional, filtros e painéis congelados. Não precisa de Excel nem de Python instalado e nunca precisa de pip. Use SEMPRE que pedirem uma planilha, .xlsx, controle, orçamento, fluxo de caixa, análise com totais/médias/metas, ou para ler/editar uma planilha existente, mesmo sem dizer 'xlsx'. Não use para Google Sheets, CSV puro, relatório em Word ou apresentação."
---

# xlsx — planilhas Excel com fórmulas reais

Você escreve um script Python curto, o Openclod o roda no **Python embutido** e sai um `.xlsx` que abre no Excel, no LibreOffice e no Google Sheets, com fórmulas que calculam de verdade. A biblioteca `openclod_office.xlsx_book` (sobre XlsxWriter) cuida do visual: cabeçalho, formatos de número, larguras, filtro, painel congelado e gráfico.

## 1. Antes de começar (sempre, um comando)

```
openclod-office check
```

Tem de terminar em "Tudo pronto". **Não rode `pip`**: as bibliotecas já estão no Python embutido, o Cowork recusa essa instalação e instalar pacotes muda o computador do usuário. Use sempre `openclod-python` (o `python` do computador pode ser outro ou nem existir). Se `openclod-office` não for reconhecido (fora do app), teste `python -c "import xlsxwriter, openpyxl"`; se faltar, diga ao usuário e peça aprovação.

## 2. Caminho rápido: planilha de vendas a partir de um CSV

Se os dados são um CSV com as colunas `mes`, `regiao` e `receita` (e, se houver, `produto` e `unidades`), **um comando gera a planilha inteira** (aba `Dados`, aba `Resumo` com SUMIF, total, média mensal, meta e atingimento, formatação condicional e gráfico):

```
openclod-python "<skill-dir>\receitas\planilha.py" "<pasta>\vendas.csv" --saida "<pasta>\analise-vendas.xlsx" --titulo "Resumo de vendas" --rodape "<texto exigido pela pasta>" --meta Sul=150000 --meta Sudeste=200000
```

- `--rodape`: o texto que o `CLAUDE.md` da pasta exige em todo documento (fica abaixo do título da aba `Resumo`). `--meta REGIAO=VALOR`: as metas **dos arquivos da pasta** (nunca invente; sem `--meta` a tabela sai sem meta e atingimento).
- O comando imprime o caminho e os totais; depois confira com `inspect` e `recalc` (passo 6 do caminho livre) e responda. `--help` lista as opções; se o CSV não tiver as colunas, ele diz quais faltam.
- Outros dados ou outro tipo de planilha (orçamento, fluxo de caixa...): siga o caminho livre.

## 3. Caminho livre (outros dados ou outro tipo de documento)

1. **Leia os dados** (CSV, outras planilhas via `document_extract`, texto) e as instruções da pasta (`CLAUDE.md`: idioma, texto obrigatório, nomes).
2. **Desenhe as abas**: `Dados` (a tabela crua, uma linha por registro, sem células mescladas) e `Resumo` (o que a pessoa lê: totais, médias, metas, gráfico). Entradas que mudam (metas, taxas) ficam em **células próprias**, nunca escondidas dentro de fórmulas.
3. **Escreva o script em `%TEMP%\openclod-xlsx\gerar.py`** (nunca na pasta do usuário) e rode `openclod-python "%TEMP%\openclod-xlsx\gerar.py"`. `%TEMP%` vale no `run_command` e no começo do caminho do `write_file`. Parta da receita `<skill-dir>\receitas\planilha.py` (leia com `read_file`; `<skill-dir>` é o `dir=` do `use_skill`): aba Dados, aba Resumo com SUMIF, total, média mensal, meta e atingimento, formatação condicional e gráfico.
4. **Toda fórmula leva o valor que o Python calculou** (`value=`): a planilha mostra números em qualquer visualizador e você tem com o que comparar. Calcule o valor esperado dos mesmos dados.
5. **Salve só a entrega na pasta do usuário.** Apague o script ao terminar.
6. **Confira antes de dizer que terminou**:
   - `openclod-office inspect "arquivo.xlsx"`: abas, fórmulas (com o valor em cache), gráficos, **AVISOS** (erro, fórmula sem valor, número guardado como texto).
   - `openclod-office recalc "arquivo.xlsx"` (precisa do LibreOffice): recalcula tudo e lista `#NAME?`, `#DIV/0!`, `#REF!` e valores em cache diferentes do recalculado. Sem LibreOffice, confira à mão as fórmulas que o `inspect` lista.

## 4. API — `from openclod_office.xlsx_book import Book`

| Chamada | O que faz |
|---|---|
| `Book(caminho, title=, author=, accent="1F4E79")` · `close()` | abre o arquivo · grava |
| `book.sheet(nome, cabecalho, linhas, formats=, widths=)` | aba com tabela em A1: cabeçalho, formatos, larguras, painel congelado, filtro e listras; sem `cabecalho` é uma aba vazia |
| `sheet.title("A1", texto)` · `note("A2", texto)` | título · observação em cinza |
| `sheet.header("A4", ["Região", "Receita"], formats)` | linha de cabeçalho em qualquer lugar |
| `sheet.put("A5", valor, kind=, bold=, total=)` | valor (texto, número, data) com formato |
| `sheet.formula("B5", "=SUMIF(...)", value=, kind=, total=)` | **fórmula real**, com o valor em cache |
| `sheet.rows("A5", linhas, formats)` | bloco de linhas (texto que começa com `=` vira fórmula) |
| `sheet.chart("column", "Título", categories="A5:A7", values="B5:B7", at="F4", number_format=)` | gráfico nativo: `column bar line pie doughnut`; vários `values` = várias séries |
| `sheet.goal_colors("D5:D8", goal=1.0)` | verde se atingiu a meta, vermelho se não |
| `sheet.widths([22, 18])` | larguras das colunas |

Formatos (`kind`/`formats`): `text int num brl brl0 pct pct0 date month`. Percentual guarda **fração** (0,85 com `pct`). `book.workbook` e `sheet.ws` são os objetos do XlsxWriter para o resto.

## 5. Fórmulas — o que dá certo

- **Nomes em inglês e vírgula** como separador: `=SUMIF(Dados!$B$2:$B$37,A5,Dados!$E$2:$E$37)`, `=AVERAGE(B10:B15)`, `=IF(C5>0,B5/C5,0)`. `SOMA` ou `SOMASE` dão `#NAME?`; o Excel em português traduz sozinho ao abrir.
- Referências **absolutas** (`$B$2:$B$37`) para os intervalos de dados, relativas para a linha atual. Nome de aba com espaço entre apóstrofos: `'Vendas 2026'!A1`.
- Proteja divisões (`IF(C5>0,B5/C5,0)`), não coloque números "mágicos" dentro da fórmula, não grave fórmula como texto. Prefira `SUMIF`, `COUNTIF`, `AVERAGE`, `INDEX/MATCH`: funcionam em qualquer Excel. `UNIQUE`, `FILTER`, `XLOOKUP` só no Excel 365 e LibreOffice recente.
- Datas: grave `datetime.date` com `kind="date"`; números: grave número (`int`/`float`), nunca "1.234,5" como texto.

## 6. Editar uma planilha existente

- Trabalhe numa **cópia**; nunca sobrescreva o original sem pedido. Use `openpyxl.load_workbook(caminho)` (fórmulas ficam como texto `=...`; `data_only=True` lê os valores em cache).
- O openpyxl **perde os valores em cache** ao salvar (o Excel recalcula ao abrir) e pode perder gráficos, imagens e formas do arquivo original: compare `openclod-office inspect` antes e depois, e avise o usuário do que não foi possível preservar.
- Para recriar uma planilha do zero com novo visual, prefira o `Book` (XlsxWriter).

## 7. Armadilhas

- No `cmd.exe` um comando não tem várias linhas e `cat <<EOF` não existe: grave o script com `write_file` e rode o arquivo (`-c` só para uma linha).
- Nome de aba: até 31 caracteres, sem `[ ] : * ? / \`. Sem células mescladas dentro de tabelas de dados.
- Gráfico de barras sempre parte de zero (o `chart()` já faz isso); use gráfico nativo, não imagem.
- Número como texto, fórmula sem valor e erro de fórmula aparecem como AVISO no `inspect`: corrija.
- Nunca invente dado. O que não estiver nos arquivos, pesquise e cite, ou diga que falta.

## 8. Resposta final

Diga o caminho do arquivo, as abas e o que cada uma traz, as fórmulas principais (e onde ficam as entradas que o usuário pode mudar), os números-chave, o que você conferiu (`inspect`, `recalc`) e o que ele deve revisar. Sem repetir a planilha.
