<!--
RASCUNHO DE ISSUE para UM defeito do ledger (D-NNN): GitHub, GitLab, Jira, Azure Boards, o que o
projeto usar. Preenchido por `scripts/mensagens.py --issue`; o que o ledger não tem sai como
[PREENCHA: ...] e o script termina com código 1 até você completar.

Regras (o porquê está em references/comunicacao-e-painel.md §7):
- É rascunho. Criar a issue é ação externa: só com ordem explícita do usuário, naquele repositório,
  naquela hora. "Monta a issue" é pedido de texto, não de criação.
- Título = o sintoma como quem usa a tela descreveria. Nome de classe vai em "Onde e por quê".
- Nunca: token, senha, cookie, connection string, dado pessoal real, print com dado sensível sem tarja.
  Repositório público expõe tudo, inclusive para sempre no histórico da issue.
- Código de registro (pedido, cliente, id) sempre com o ambiente junto: os códigos se repetem entre
  ambientes.
- "O que não foi validado" nunca sai. Se nada ficou, diga que nada ficou.
- Decisão de produto vira pergunta fechada (opções e efeito de cada uma), não ordem de correção.
Este bloco de comentário é removido pelo gerador. Os marcadores {{...}} são trocados pelo ledger.
-->
# {{TITULO}}

| Campo | Valor |
|---|---|
| Severidade | {{SEVERIDADE}} |
| Tipo | {{TIPO}} |
| Situação no QA | {{STATUS}} |
| Ambiente | {{AMBIENTE}} |
| Código testado | {{CODIGO_TESTADO}} |
| Papel / usuário de teste | {{PAPEL}} |
| Rodada de QA | {{RODADA}} · {{ID}} · casos {{CASOS}} |
| Achado em | {{DATA}} |

## Resumo

{{RESUMO}}

## Como reproduzir

{{PASSOS}}

## Esperado

{{ESPERADO}}

De onde vem o esperado (oráculo): {{ORACULO}}

## Obtido

{{OBTIDO}}

## Evidências

{{EVIDENCIAS}}

Reproduzido por outro caminho: {{REPRODUZIDO}}

## Onde e por quê

- Local: {{ONDE}}
- Causa provável: {{CAUSA}}
- Correção proposta ou aplicada: {{CORRECAO}}
- Reteste: {{RETESTE}}

## O que não foi validado

{{NAO_VALIDADO}}

<!-- rótulos sugeridos: {{ROTULOS}} -->
