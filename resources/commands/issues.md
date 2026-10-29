---
description: Procura issues do GitHub do repositório atual parecidas com um problema (gh, só leitura)
argument-hint: "<erro, sintoma ou pedido>"
allowed-tools: Bash, git_status
---

Procure, com o `gh` (só leitura: não crie nem comente issues), issues do repositório atual parecidas com:

$ARGUMENTS

Considere:

1. Títulos ou descrições parecidos.
2. A mesma mensagem de erro ou o mesmo sintoma.
3. Funcionalidade ou componente relacionado.
4. Pedidos de recurso parecidos.

Use `gh issue list --search "<termos>" --state all --limit 30` com variações dos termos e leia as candidatas com `gh issue view <n>`.

Liste as que batem com: número e título, por que bate (uma frase) e o link. Se nenhuma bater de verdade, diga isso.
