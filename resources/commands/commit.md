---
description: Faz o commit das mudanças com uma mensagem clara (sem push)
argument-hint: "[instruções extras]"
allowed-tools: git_status, git_diff, git_log, git_commit, Bash, Read, Grep
---

Faça o commit das mudanças do repositório. **Não faça push** e não mude de branch.

1. Veja o que mudou: `git_status`, o diff do que não está preparado e do que já está (`git diff` e `git diff --cached`).
2. Se houver conflito de merge, **pare** e me diga quais arquivos estão em conflito; não tente resolver.
3. Commite só o que pertence à mesma mudança. Arquivos que parecem de outra tarefa, temporários ou com segredo (`.env`, chaves) ficam de fora — diga quais deixou de fora e por quê.
4. Mensagem no formato `tipo(escopo): resumo`, com `tipo` entre `feat`, `fix`, `docs`, `chore`, `refactor` ou `test` (escopo opcional), no idioma das mensagens anteriores do repositório (veja `git_log`).
5. Explique **por que** a mudança foi feita, do ponto de vista de quem usa, e não só o que mudou. Nada de mensagens genéricas como "melhorias gerais": diga exatamente o que muda para o usuário.

Ao terminar, mostre o hash e a mensagem do commit.

$ARGUMENTS
