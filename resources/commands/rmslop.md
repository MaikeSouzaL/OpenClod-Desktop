---
description: Tira do diff da branch o "lixo de IA" (comentários, checagens e casts que destoam do arquivo)
argument-hint: "[branch base, padrão main]"
allowed-tools: git_status, git_diff, git_log, Bash, Read, Edit, Grep, Glob
---

Compare a branch atual com a base (`$ARGUMENTS`; se vazio, `main`, ou `dev` se não houver `main`) e remova o que foi gerado por IA e destoa do resto do código, só no que esta branch introduziu:

- comentários que uma pessoa não escreveria ou que destoam do arquivo;
- checagens defensivas e `try/catch` fora do normal naquela parte do código (sobretudo em caminhos já validados);
- casts para `any` só para calar o tipo;
- qualquer estilo que destoe do arquivo;
- emojis desnecessários.

Não mude comportamento. Rode o typecheck e os testes que existirem depois.

No fim, só 1 a 3 frases dizendo o que mudou.
