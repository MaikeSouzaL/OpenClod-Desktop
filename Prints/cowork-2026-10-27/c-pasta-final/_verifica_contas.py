"""Confere as contas do comparativo.md a partir dos dados das fichas.
Nao le as fichas: os valores abaixo foram transcritos manualmente delas
(conferidos contra o texto). Uso: python _verifica_contas.py
"""
from statistics import mean

# nome: (preco, share_pct, nota_pressao_preco, nota_participacao, nota_diferenciacao, ajuste_ponto_fraco)
DADOS = {
    "Alfa Cloud":    (89, 24, 8.0, 10.0, 8.0, -1.0),
    "Gama Systems":  (59, 15, 10.0, 6.3, 0.5, -0.8),
    "Épsilon Hub":   (99, 9, 10.0, 3.8, 5.0, -0.8),
    "Beta Soft":     (129, 18, 4.0, 7.5, 7.0, -0.5),
    "Delta One":     (149, 12, 2.5, 5.0, 7.0, -0.8),
    "Zeta Labs":     (179, 7, 1.0, 2.9, 6.0, -0.3),
}

NOSSO_PRECO = 99

print(f"Soma das participacoes declaradas: {sum(d[1] for d in DADOS.values())}%")
print(f"Delta de preco vs R$ {NOSSO_PRECO}:")
for nome, (preco, share, *_ ) in DADOS.items():
    print(f"  {nome:<14} R$ {preco:>3} -> {(preco/NOSSO_PRECO - 1)*100:+.0f}%")

print("\nEscala de participacao (10 * share / 24):")
for nome, (_, share, *_) in DADOS.items():
    print(f"  {nome:<14} {share:>2}% -> {10*share/24:.2f}")

print("\nIndice de ameaca = 0,4*pressao + 0,3*participacao + 0,3*diferenciacao + ajuste:")
linhas = []
for nome, (_, _, p, m, d, aj) in DADOS.items():
    base = 0.4 * p + 0.3 * m + 0.3 * d
    idx = round(base + aj, 1)
    linhas.append((idx, nome, base, aj))
    print(f"  {nome:<14} {0.4*p:4.1f} + {0.3*m:4.2f} + {0.3*d:4.2f} = {base:5.2f} {aj:+.1f} -> {idx:4.1f}")

print("\nRanking:")
for pos, (idx, nome, _, _) in enumerate(sorted(linhas, reverse=True), 1):
    print(f"  {pos}. {nome:<14} {idx:.1f}/10")
