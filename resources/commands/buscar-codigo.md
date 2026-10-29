---
description: Procura um padrão no código e resume onde e como ele aparece
argument-hint: "<padrão ou nome>"
allowed-tools: Grep, Glob, Read, LS, code_intelligence
---

Procure no projeto o padrão `$ARGUMENTS` (texto, nome de função, classe, variável ou expressão regular) e resuma o que encontrou:

- onde aparece (arquivos e linhas), agrupado por papel: definição, usos, testes, configuração;
- como é usado e o que muda de um uso para outro;
- o que chama atenção (uso inconsistente, código morto, lugares que parecem esquecidos).

Não altere arquivos. Se houver muitos resultados, mostre os mais importantes e diga quantos ficaram de fora.
