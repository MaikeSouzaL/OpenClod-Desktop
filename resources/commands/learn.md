---
description: Guarda o que esta sessão descobriu de não óbvio nos AGENTS.md mais próximos do código
argument-hint: "[foco]"
---

Analise esta sessão e registre os aprendizados **não óbvios** em arquivos `AGENTS.md` (o Openclod os lê junto com o `CLAUDE.md`). Um `AGENTS.md` pode ficar em qualquer pasta: ponha cada aprendizado o mais perto possível do código a que se refere.

- Vale para o projeto todo → `AGENTS.md` da raiz.
- De um pacote ou módulo → `pacotes/x/AGENTS.md`.
- De uma funcionalidade → `src/auth/AGENTS.md`.

**Conta como aprendizado:** relação escondida entre arquivos; caminho de execução diferente do que o código aparenta; configuração, variável de ambiente ou flag não óbvia; erro cuja mensagem enganava e a solução; peculiaridade de API ou ferramenta e o contorno; comando de build ou teste que não está no README; decisão de arquitetura e restrição; arquivos que precisam mudar juntos.

**Não conta:** o que a documentação já diz, comportamento padrão da linguagem ou do framework, o que já está num `AGENTS.md`, explicação longa, detalhe que só vale para esta sessão.

Passos:

1. Revise a sessão: descobertas, erros que levaram várias tentativas, ligações inesperadas.
2. Para cada aprendizado, decida a pasta.
3. Leia os `AGENTS.md` que já existem nesses níveis.
4. Crie ou atualize, com 1 a 3 linhas por aprendizado.

No fim, diga quais `AGENTS.md` foram criados ou atualizados e quantos aprendizados em cada um.

$ARGUMENTS
