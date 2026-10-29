---
description: Revisa o diff atual atrás de bugs, falhas de segurança e código desnecessário
argument-hint: "[arquivos, branch ou foco]"
allowed-tools: git_status, git_diff, git_log, Read, Grep, Glob, LS, code_intelligence
---

Revise a mudança atual (o que está no diff, preparado ou não; se eu indicar uma branch ou arquivos abaixo, revise isso). Seja preciso: cite o arquivo e as linhas e explique como a falha acontece. Não altere nenhum arquivo.

## Correção (para todo trecho alterado)

- **Erros silenciosos:** chave, linha ou registro ausente, `null`/`undefined` ou exceção que viram um valor padrão (`0`, `""`, `[]`) em vez de aparecer como erro.
- **Limites:** laços, fatias, intervalos, comparações inclusivas × exclusivas (erro de um a mais ou a menos).
- **Retornos de erro ignorados** e promessas sem `await`.
- **Concorrência:** estado mutável compartilhado sem trava, I/O bloqueante em caminho assíncrono, ordem de travas que pode travar.
- **Recursos:** arquivos, sockets, processos e timers que não são fechados em todo caminho (inclusive no de erro).
- **Entrada não confiável** chegando a SQL, shell, caminhos de arquivo, desserialização ou templates sem validação.
- **Estado que vaza entre pedidos:** variáveis de módulo, caches e argumentos padrão mutáveis.
- **Lógica que contradiz o comentário ou o nome da função.**

## Qualidade

- Gambiarras, blocos copiados que divergiram, código morto, verificações redundantes.
- Abstração demais (um wrapper com um só uso) ou de menos (o mesmo bloco repetido no diff). Recomende uma única ação, só quando melhora o código atual.

## Regras

- Comente só o que o diff mudou; código anterior apenas se o diff mudar o comportamento dele.
- Poucos achados certos valem mais que muitos duvidosos. Estilo é severidade `baixa`; `alta`/`crítica` só para bug real, regressão ou segurança.

## Saída

Uma lista ordenada por severidade. Para cada achado: **severidade** (crítica, alta, média, baixa), **arquivo:linhas**, o problema e como corrigir. Se não houver nada, diga "Nenhum problema encontrado" e o que você conferiu.

$ARGUMENTS
