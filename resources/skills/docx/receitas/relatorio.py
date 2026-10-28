# -*- coding: utf-8 -*-
"""Receita: relatório em Word (resumo executivo, tabela por região, gráfico, conclusões) a partir de um CSV de vendas.

Caminho rápido, um comando (o texto exigido pelas instruções da pasta vai em --rodape):
    openclod-python relatorio.py vendas.csv --saida relatorio-vendas.docx --rodape "Preparado pela Equipe Alfa" --meta Sul=150000 --meta Sudeste=200000
O CSV precisa das colunas mes, regiao e receita (produto e unidades são opcionais; maiúsculas e acentos não importam; ; ou , como separador).
Sem CSV, gera um exemplo com dados inventados. Para dados em outro formato, copie este arquivo para %TEMP%, mude carregar() e os textos.
Opções: --titulo, --subtitulo, --autor, --meta REGIAO=VALOR (repetível), --conclusao "texto" (repetível; substitui as conclusões padrão).
"""
import argparse
import csv
import os
import tempfile
import unicodedata
from collections import defaultdict

from openclod_office import brl, pct
from openclod_office.charts import bar_png
from openclod_office.docx_report import Report

METAS_EXEMPLO = {"Sul": 150000, "Sudeste": 200000, "Nordeste": 130000}


def chave(texto):
    return "".join(c for c in unicodedata.normalize("NFD", str(texto).strip().lower()) if unicodedata.category(c) != "Mn")


def numero(texto):
    """'1.234,56' (pt-BR) e '1234.56' viram float."""
    t = str(texto).strip().replace("R$", "").replace(" ", "")
    return float(t.replace(".", "").replace(",", ".") if "," in t else t)


def carregar(caminho):
    if not caminho:
        return [
            {"mes": mes, "regiao": regiao, "receita": (40 + (m * 7 + r * 13 + p * 5) % 23) * preco * 2}
            for m, mes in enumerate(["Jan", "Fev", "Mar", "Abr", "Mai", "Jun"])
            for r, regiao in enumerate(METAS_EXEMPLO)
            for p, preco in enumerate([99, 199])
        ]
    with open(caminho, encoding="utf-8-sig", newline="") as arquivo:
        primeira = arquivo.readline()
        arquivo.seek(0)
        leitor = csv.DictReader(arquivo, delimiter=";" if primeira.count(";") > primeira.count(",") else ",")
        campos = {chave(c): c for c in (leitor.fieldnames or [])}
        falta = [n for n in ("mes", "regiao", "receita") if n not in campos]
        if falta:
            raise SystemExit("O CSV precisa das colunas mes, regiao e receita; faltam: %s. Colunas encontradas: %s" % (", ".join(falta), ", ".join(leitor.fieldnames or [])))
        return [{"mes": l[campos["mes"]], "regiao": l[campos["regiao"]], "receita": numero(l[campos["receita"]])} for l in leitor if l[campos["receita"]].strip()]


def metas_de(itens):
    metas = {}
    for item in itens or []:
        nome, _, valor = item.partition("=")
        if not valor:
            raise SystemExit("--meta precisa ser REGIAO=VALOR (ex.: --meta Sul=150000)")
        metas[nome.strip()] = numero(valor)
    return metas


def construir(linhas, saida, titulo, subtitulo, autor, rodape, metas, conclusoes):
    por_regiao = defaultdict(float)
    for linha in linhas:
        por_regiao[linha["regiao"]] += linha["receita"]
    total = sum(por_regiao.values())
    ordem = sorted(por_regiao, key=por_regiao.get, reverse=True)
    com_meta = any(r in metas for r in ordem)
    meta_total = sum(metas.get(r, 0) for r in ordem)
    lider, ultima = ordem[0], ordem[-1]

    doc = Report(titulo, subtitle=subtitulo, author=autor, byline=rodape, footer=rodape)
    doc.heading("Resumo executivo")
    frase = "A receita do período foi de **%s**" % brl(total)
    if com_meta and meta_total:
        frase += ", %s da meta de %s" % (pct(total / meta_total, 0), brl(meta_total))
    frase += ". A região **%s** responde por %s do total; a menor receita é a de **%s** (%s)." % (lider, pct(por_regiao[lider] / total, 0), ultima, brl(por_regiao[ultima]))
    doc.paragraph(frase)
    if com_meta:
        abaixo = [r for r in ordem if metas.get(r) and por_regiao[r] < metas[r]]
        doc.callout("Abaixo da meta: %s." % ", ".join(abaixo) if abaixo else "Todas as regiões que têm meta a atingiram.", title="Destaque")

    doc.heading("Receita por região")
    if com_meta:
        tabela = [[r, por_regiao[r], por_regiao[r] / total, metas.get(r), (por_regiao[r] / metas[r]) if metas.get(r) else None] for r in ordem]
        tabela.append(["Total", total, 1.0, meta_total, (total / meta_total) if meta_total else None])
        doc.table(["Região", "Receita", "% do total", "Meta", "Atingimento"], tabela, formats=["text", "brl0", "pct", "brl0", "pct"], total=True, caption="Receita, meta e atingimento por região")
    else:
        tabela = [[r, por_regiao[r], por_regiao[r] / total] for r in ordem] + [["Total", total, 1.0]]
        doc.table(["Região", "Receita", "% do total"], tabela, formats=["text", "brl0", "pct"], total=True, caption="Receita por região")

    grafico = os.path.join(tempfile.gettempdir(), "receita-por-regiao.png")  # imagem de apoio fica no %TEMP%, não na pasta do usuário
    bar_png(grafico, ordem, [por_regiao[r] for r in ordem], value_format=lambda v: brl(v, 0))
    doc.image(grafico, width_cm=15, caption="Receita por região no período")

    doc.heading("Conclusões e recomendações")
    doc.bullets(conclusoes or [
        "Manter o foco comercial em **%s**, a região de maior receita." % lider,
        "Acompanhar de perto **%s**, a de menor receita." % ultima,
        "Revisar metas e preços no próximo ciclo de planejamento.",
    ])
    doc.save(saida)
    print(saida)
    print("Receita total %s · %s" % (brl(total), " · ".join("%s %s" % (r, brl(por_regiao[r])) for r in ordem)))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Relatório em Word a partir de um CSV de vendas (colunas mes, regiao, receita).")
    ap.add_argument("csv", nargs="?", help="CSV de vendas; sem ele, gera um exemplo")
    ap.add_argument("--saida", default="relatorio-vendas.docx")
    ap.add_argument("--titulo", default="Relatório de vendas")
    ap.add_argument("--subtitulo", default="Diretoria Comercial")
    ap.add_argument("--autor", default="")
    ap.add_argument("--rodape", default=None, help="texto fixo no rodapé e abaixo do título (ex.: o texto exigido pela pasta)")
    ap.add_argument("--meta", action="append", help="REGIAO=VALOR, repetível")
    ap.add_argument("--conclusao", action="append", help="uma conclusão ou recomendação, repetível")
    args = ap.parse_args()
    metas = metas_de(args.meta) or (METAS_EXEMPLO if not args.csv else {})
    construir(carregar(args.csv), args.saida, args.titulo, args.subtitulo, args.autor, args.rodape, metas, args.conclusao)
