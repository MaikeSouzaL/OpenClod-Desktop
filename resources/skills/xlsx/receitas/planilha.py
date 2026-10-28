# -*- coding: utf-8 -*-
"""Receita: planilha com a aba Dados e uma aba Resumo de FÓRMULAS REAIS (total, média mensal, meta e atingimento por região) e um gráfico.

Caminho rápido, um comando (o texto exigido pelas instruções da pasta vai em --rodape):
    openclod-python planilha.py vendas.csv --saida analise-vendas.xlsx --rodape "Preparado pela Equipe Alfa" --meta Sul=150000 --meta Sudeste=200000
O CSV precisa das colunas mes, regiao e receita (produto e unidades são opcionais; maiúsculas e acentos não importam; ; ou , como separador).
Sem CSV, gera um exemplo com dados inventados. Para dados em outro formato, copie este arquivo para %TEMP%, mude carregar() e o resumo.
Opções: --titulo, --meta REGIAO=VALOR (repetível; sem meta, a tabela não traz meta nem atingimento).
Regra: toda fórmula leva o valor que o Python calculou (value=), então a planilha mostra números em qualquer visualizador, e
`openclod-office recalc` compara esse valor com o que o LibreOffice recalcula.
"""
import argparse
import csv
import unicodedata

from openclod_office import brl
from openclod_office.xlsx_book import Book

METAS_EXEMPLO = {"Sul": 150000, "Sudeste": 200000, "Nordeste": 130000}


def chave(texto):
    return "".join(c for c in unicodedata.normalize("NFD", str(texto).strip().lower()) if unicodedata.category(c) != "Mn")


def numero(texto):
    """'1.234,56' (pt-BR) e '1234.56' viram float."""
    t = str(texto).strip().replace("R$", "").replace(" ", "")
    return float(t.replace(".", "").replace(",", ".") if "," in t else t)


def carregar(caminho):
    """Linhas [mes, regiao, produto, unidades, receita]."""
    if not caminho:
        return [
            [mes, regiao, produto, (40 + (m * 7 + r * 13 + p * 5) % 23), (40 + (m * 7 + r * 13 + p * 5) % 23) * preco * 2]
            for m, mes in enumerate(["Jan", "Fev", "Mar", "Abr", "Mai", "Jun"])
            for r, regiao in enumerate(METAS_EXEMPLO)
            for p, (produto, preco) in enumerate([("Plano Basico", 99), ("Plano Pro", 199)])
        ]
    with open(caminho, encoding="utf-8-sig", newline="") as arquivo:
        primeira = arquivo.readline()
        arquivo.seek(0)
        leitor = csv.DictReader(arquivo, delimiter=";" if primeira.count(";") > primeira.count(",") else ",")
        campos = {chave(c): c for c in (leitor.fieldnames or [])}
        falta = [n for n in ("mes", "regiao", "receita") if n not in campos]
        if falta:
            raise SystemExit("O CSV precisa das colunas mes, regiao e receita; faltam: %s. Colunas encontradas: %s" % (", ".join(falta), ", ".join(leitor.fieldnames or [])))
        pegar = lambda l, nome: l[campos[nome]] if nome in campos else ""
        return [
            [l[campos["mes"]], l[campos["regiao"]], pegar(l, "produto"), int(numero(pegar(l, "unidades"))) if pegar(l, "unidades").strip() else None, numero(l[campos["receita"]])]
            for l in leitor
            if l[campos["receita"]].strip()
        ]


def metas_de(itens):
    metas = {}
    for item in itens or []:
        nome, _, valor = item.partition("=")
        if not valor:
            raise SystemExit("--meta precisa ser REGIAO=VALOR (ex.: --meta Sul=150000)")
        metas[nome.strip()] = numero(valor)
    return metas


def construir(linhas, saida, titulo, rodape, metas):
    ultimo = len(linhas) + 1  # a linha 1 é o cabeçalho
    regioes = sorted({l[1] for l in linhas}, key=lambda r: (r not in metas, list(metas).index(r) if r in metas else 0, r))
    meses = list(dict.fromkeys(l[0] for l in linhas))  # na ordem em que aparecem
    total = sum(l[4] for l in linhas)
    com_meta = any(r in metas for r in regioes)

    livro = Book(saida, title=titulo, author="")
    livro.sheet("Dados", ["Mês", "Região", "Produto", "Unidades", "Receita"], linhas, formats=["text", "text", "text", "int", "brl0"])
    resumo = livro.sheet("Resumo", tab_color="1F4E79")
    resumo.title("A1", titulo)
    if rodape:
        resumo.note("A2", rodape)

    # --- por região: receita (SUMIF) e, se houver meta, meta (dado de entrada) e atingimento (divisão)
    cabecalho = ["Região", "Receita"] + (["Meta", "Atingimento"] if com_meta else [])
    resumo.header("A4", cabecalho, ["text", "brl0"] + (["brl0", "pct"] if com_meta else []))
    for i, regiao in enumerate(regioes):
        r = 5 + i
        receita = sum(l[4] for l in linhas if l[1] == regiao)
        resumo.put("A%d" % r, regiao)
        resumo.formula("B%d" % r, "=SUMIF(Dados!$B$2:$B$%d,A%d,Dados!$E$2:$E$%d)" % (ultimo, r, ultimo), value=receita, kind="brl0")
        if com_meta:
            resumo.put("C%d" % r, metas.get(regiao), kind="brl0")
            resumo.formula("D%d" % r, "=IF(C%d>0,B%d/C%d,0)" % (r, r, r), value=(receita / metas[regiao]) if metas.get(regiao) else 0, kind="pct")
    first, last = 5, 4 + len(regioes)
    t = last + 1
    meta_total = sum(metas.get(r, 0) for r in regioes)
    resumo.put("A%d" % t, "Total", bold=True, total=True)
    resumo.formula("B%d" % t, "=SUM(B%d:B%d)" % (first, last), value=total, kind="brl0", total=True)
    if com_meta:
        resumo.formula("C%d" % t, "=SUM(C%d:C%d)" % (first, last), value=meta_total, kind="brl0", total=True)
        resumo.formula("D%d" % t, "=IF(C%d>0,B%d/C%d,0)" % (t, t, t), value=(total / meta_total) if meta_total else 0, kind="pct", total=True)
        resumo.goal_colors("D%d:D%d" % (first, t))

    # --- por mês e média mensal
    m0 = t + 3
    resumo.header("A%d" % m0, ["Mês", "Receita"], ["text", "brl0"])
    for i, mes in enumerate(meses):
        r = m0 + 1 + i
        resumo.put("A%d" % r, mes)
        resumo.formula("B%d" % r, "=SUMIF(Dados!$A$2:$A$%d,A%d,Dados!$E$2:$E$%d)" % (ultimo, r, ultimo), value=sum(l[4] for l in linhas if l[0] == mes), kind="brl0")
    ml = m0 + len(meses)
    resumo.put("A%d" % (ml + 1), "Média mensal", bold=True, total=True)
    resumo.formula("B%d" % (ml + 1), "=AVERAGE(B%d:B%d)" % (m0 + 1, ml), value=total / len(meses), kind="brl0", total=True)

    resumo.widths([22, 18, 18, 16])
    resumo.chart("column", "Receita por região", categories="A%d:A%d" % (first, last), values="B%d:B%d" % (first, last), at="F4", number_format='"R$" #,##0')
    livro.close()
    print(saida)
    print("Receita total %s · %d região(ões) · %d mês(es) · %d linhas de dados" % (brl(total), len(regioes), len(meses), len(linhas)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Planilha com Dados e Resumo (fórmulas reais) a partir de um CSV de vendas (colunas mes, regiao, receita).")
    ap.add_argument("csv", nargs="?", help="CSV de vendas; sem ele, gera um exemplo")
    ap.add_argument("--saida", default="analise-vendas.xlsx")
    ap.add_argument("--titulo", default="Resumo de vendas")
    ap.add_argument("--rodape", default=None, help="texto fixo abaixo do título (ex.: o texto exigido pela pasta)")
    ap.add_argument("--meta", action="append", help="REGIAO=VALOR, repetível")
    args = ap.parse_args()
    metas = metas_de(args.meta) or (METAS_EXEMPLO if not args.csv else {})
    construir(carregar(args.csv), args.saida, args.titulo, args.rodape, metas)
