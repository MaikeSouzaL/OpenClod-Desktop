# -*- coding: utf-8 -*-
"""Receita: apresentação de 5 slides (capa, números, gráfico, tabela, próximos passos), com gráfico nativo e notas do apresentador.

Caminho rápido, um comando (o texto exigido pelas instruções da pasta vai em --rodape):
    openclod-python apresentacao.py vendas.csv --saida apresentacao-vendas.pptx --rodape "Preparado pela Equipe Alfa" --meta Sul=150000 --meta Sudeste=200000
O CSV precisa das colunas mes, regiao e receita (produto e unidades são opcionais; maiúsculas e acentos não importam; ; ou , como separador).
Sem CSV, gera um exemplo com dados inventados. Para dados em outro formato ou mais slides, copie este arquivo para %TEMP%, mude carregar()
e acrescente chamadas deck.*_slide(...) antes de deck.save().
Opções: --titulo, --subtitulo, --meta REGIAO=VALOR (repetível), --passo "texto" (repetível; os próximos passos do último slide).
"""
import argparse
import csv
import unicodedata
from collections import defaultdict

from openclod_office import brl, pct
from openclod_office.pptx_deck import Deck

METAS_EXEMPLO = {"Sul": 150000, "Sudeste": 200000, "Nordeste": 130000}


def chave(texto):
    return "".join(c for c in unicodedata.normalize("NFD", str(texto).strip().lower()) if unicodedata.category(c) != "Mn")


def numero(texto):
    """'1.234,56' (pt-BR) e '1234.56' viram float."""
    t = str(texto).strip().replace("R$", "").replace(" ", "")
    return float(t.replace(".", "").replace(",", ".") if "," in t else t)


def carregar(caminho):
    """Tuplas (mes, regiao, receita)."""
    if not caminho:
        return [
            (mes, regiao, (40 + (m * 7 + r * 13 + p * 5) % 23) * preco * 2)
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
        return [(l[campos["mes"]], l[campos["regiao"]], numero(l[campos["receita"]])) for l in leitor if l[campos["receita"]].strip()]


def metas_de(itens):
    metas = {}
    for item in itens or []:
        nome, _, valor = item.partition("=")
        if not valor:
            raise SystemExit("--meta precisa ser REGIAO=VALOR (ex.: --meta Sul=150000)")
        metas[nome.strip()] = numero(valor)
    return metas


def construir(linhas, saida, titulo, subtitulo, rodape, metas, passos):
    por_regiao, por_mes = defaultdict(float), defaultdict(float)
    for mes, regiao, receita in linhas:
        por_regiao[regiao] += receita
        por_mes[mes] += receita
    total = sum(por_regiao.values())
    ordem = sorted(por_regiao, key=por_regiao.get, reverse=True)
    com_meta = any(r in metas for r in ordem)
    meta_total = sum(metas.get(r, 0) for r in ordem)
    media = total / len(por_mes)

    deck = Deck(title=titulo, footer=rodape)
    deck.title_slide(titulo, " · ".join(p for p in (subtitulo, rodape) if p), notes="Abertura: o período e o objetivo da reunião.")
    if com_meta and meta_total:
        kpis = [("Receita total", brl(total)), ("Meta", brl(meta_total)), ("Atingimento", pct(total / meta_total, 0)), ("Média mensal", brl(media))]
        leitura = ["A receita fechou **%s** da meta" % pct(total / meta_total, 0), "A melhor região foi **%s**" % ordem[0]]
    else:
        kpis = [("Receita total", brl(total)), ("Média mensal", brl(media)), ("Melhor região", ordem[0]), ("Regiões", str(len(ordem)))]
        leitura = ["**%s** lidera com %s da receita" % (ordem[0], pct(por_regiao[ordem[0]] / total, 0)), "Menor receita: **%s** (%s)" % (ordem[-1], brl(por_regiao[ordem[-1]]))]
    deck.kpi_slide("Os números do período", kpis, bullets=leitura, notes="Comece pelos números principais e depois abra por região.")
    deck.chart_slide(
        "Receita por região",
        ordem,
        {"Receita": [por_regiao[r] for r in ordem]},
        kind="column",
        number_format='"R$" #,##0',
        insight=["**%s** lidera com %s do total" % (ordem[0], pct(por_regiao[ordem[0]] / total, 0)), "Diferença entre a maior e a menor: %s" % brl(por_regiao[ordem[0]] - por_regiao[ordem[-1]])],
        notes="Gráfico nativo: dá para editar os dados no PowerPoint.",
    )
    if com_meta:
        tabela = [[r, por_regiao[r], metas.get(r), (por_regiao[r] / metas[r]) if metas.get(r) else None] for r in ordem]
        tabela.append(["Total", total, meta_total, (total / meta_total) if meta_total else None])
        deck.table_slide("Meta × realizado por região", ["Região", "Receita", "Meta", "Atingimento"], tabela, formats=["text", "brl0", "brl0", "pct"], total=True)
    else:
        tabela = [[r, por_regiao[r], por_regiao[r] / total] for r in ordem] + [["Total", total, 1.0]]
        deck.table_slide("Receita por região", ["Região", "Receita", "% do total"], tabela, formats=["text", "brl0", "pct"], total=True)
    deck.bullets_slide(
        "Decisões e próximos passos",
        passos or ["Priorizar a região de maior receita (**%s**)" % ordem[0], "Rever preços onde o resultado ficou abaixo do esperado", "Definir responsáveis e prazos na próxima reunião"],
        lead="Frentes para o próximo ciclo",
        notes="Fechar pedindo as decisões.",
    )
    deck.save(saida)
    print(saida)
    print("Receita total %s · 5 slides (capa, números, gráfico, tabela, próximos passos)" % brl(total))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Apresentação de 5 slides a partir de um CSV de vendas (colunas mes, regiao, receita).")
    ap.add_argument("csv", nargs="?", help="CSV de vendas; sem ele, gera um exemplo")
    ap.add_argument("--saida", default="apresentacao-vendas.pptx")
    ap.add_argument("--titulo", default="Resultados de vendas")
    ap.add_argument("--subtitulo", default="Diretoria Comercial")
    ap.add_argument("--rodape", default=None, help="texto fixo no rodapé e na capa (ex.: o texto exigido pela pasta)")
    ap.add_argument("--meta", action="append", help="REGIAO=VALOR, repetível")
    ap.add_argument("--passo", action="append", help="um próximo passo para o último slide, repetível")
    args = ap.parse_args()
    metas = metas_de(args.meta) or (METAS_EXEMPLO if not args.csv else {})
    construir(carregar(args.csv), args.saida, args.titulo, args.subtitulo, args.rodape, metas, args.passo)
