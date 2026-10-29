---
description: Lista as dependências que podem subir de versão menor ou correção, sem atualizar nada
argument-hint: "[pacotes ou foco]"
---

Leia os manifestos de dependências do projeto (`package.json` da raiz e dos pacotes, ou `requirements.txt`/`pyproject.toml`, `Cargo.toml`, `go.mod`… conforme o projeto).

Para cada dependência, descubra se há versão **menor ou de correção** mais nova (ignore as versões maiores, que mudam a API). **Não atualize nada**: só o levantamento.

Para cada uma que pode subir: versão atual → versão possível, um resumo curto do que mudou (correções, recursos novos) e o link do changelog ou das notas de versão. Se forem muitas, divida o trabalho entre agentes (um por grupo de dependências) para economizar contexto.

Escreva o resultado em `atualizacoes-dependencias.md` na raiz do projeto e mostre um resumo aqui.

$ARGUMENTS
