---
description: Revisa um pull request do GitHub (precisa do gh instalado e autenticado)
argument-hint: "<número, URL, dono/repo#número ou descrição>"
allowed-tools: Bash, Read, Grep, Glob, git_log
---

Revise o pull request: $ARGUMENTS

Use o `gh` só para **ler**: não comente, não aprove, não faça merge nem altere nada no GitHub.

1. **Ache o PR.** Pode ser uma URL, `dono/repo#123`, um número (repositório atual) ou uma descrição — nesse caso, `gh pr list --search "<descrição>" --limit 5` e escolha o melhor. Depois: `gh pr view <PR> --json number,title,body,author,state,baseRefName,headRefName,url,labels,additions,deletions,changedFiles,reviewDecision,reviews`.
2. **Diff:** `gh pr diff <PR>`. Se passar de 3000 linhas, comece pelos arquivos mais importantes e resuma o resto.
3. **Discussão:** comentários e revisões (`gh api repos/{dono}/{repo}/pulls/{n}/comments --paginate`, `.../issues/{n}/comments`, `.../pulls/{n}/reviews`). Note pedidos de mudança, respostas do autor e conversas sem resolução.
4. **Issues ligadas:** `#123`, `fixes #123`, `closes #123` no corpo, na branch ou nos commits; leia cada uma com `gh issue view <n> --json title,body,comments,state`.
5. **Analise:** resolve o problema descrito? Falta algo? Há mudança fora do escopo? Bugs ou casos de borda? Tem testes que importam? Pode quebrar algo existente? Ficou comentário de revisão sem resposta?

## Formato

### Revisão do PR: `<título>` (<url>)
**Autor:** … | **Estado:** … | **Decisão de revisão:** …
**Base:** `<base>` ← `<head>` | **Arquivos:** n | **+adições / −remoções**

- **Problema:** 1–3 frases.
- **Solução:** 1–3 frases sobre a abordagem.
- **Mudanças principais:** por tema, com os caminhos.
- **Issues ligadas:** título, estado e resumo da discussão.
- **Destaques da discussão:** o que revisores e autor disseram; conversas em aberto.
- **Preocupações:** bugs, falta de testes, escopo, retorno não atendido — ou "Nenhuma".
- **Veredito:** APROVAR / PEDIR MUDANÇAS / PRECISA DE DISCUSSÃO, com a justificativa.
- **Ação sugerida:** o que aprovar, o que questionar.
