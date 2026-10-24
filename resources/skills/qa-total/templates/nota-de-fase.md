---
name: "{{rodada-slug}}-{{NN}}-{{fase-slug}}"
description: "{{Fase F: o que foi testado e o resultado em uma frase, com número. Ex.: cadastro de cliente — 38 casos, 34 passaram, 2 defeitos corrigidos e retestados, 2 bloqueados por falta do papel aprovador}}"
metadata:
  type: project
  rodada: "{{AAAA-MM-DD-alvo-slug}}"
  fase: "{{número da fase no SKILL.md §3}}"
  arquivo: "{{NN}}-{{nome}}.md"
  modified: "{{saída de date -Iseconds no momento da escrita; nunca estimado}}"
---

<!--
Modelo de nota de fase. Salve em .qa/<rodada>/notas/NN-<nome>.md (ou na pasta que o PERFIL indicar).
NN é a sequência do arquivo na tabela do SKILL.md §3, não o número da fase (F): a fase 3 grava
02-inventario.md, a fase 11 grava 10-aprender.md. O gate procura as notas por esse nome.
Atualize A CADA PASSO, não no fim: a janela de contexto acaba no meio do trabalho.
Troque cada {{...}}. Não apague seção vazia: escreva "Nenhum" — a ausência registrada é informação.
Imagens: caminho relativo ../evidencias/... Se o PERFIL apontar um cofre Obsidian, use ![[evidencias/arquivo.png]].
Ao atualizar, troque o modified pela saída de date.
-->

# {{nome da fase}} (fase {{F}}, nota {{NN}})

| | |
|---|---|
| Rodada | `{{AAAA-MM-DD-alvo-slug}}` |
| Alvo | {{tela, fluxo, endpoint, comando ou função}} |
| Ambiente | {{o que foi medido (host da API e banco, ou interpretador e caminho do pacote)}} (confirmado em {{como: aba de rede, sessão no banco, log do comando}}) |
| Papel / usuário (ou "sem papel") | {{papel}} (sessão aberta pelo usuário, quando há papel) |
| Código testado | `{{branch}}` @ `{{commit curto}}` |
| Início · fim | {{date}} · {{date}} |
| Ledger | `../cobertura.json` |

## Resumo

- **Feito:** {{o que foi exercitado nesta fase, em 1 a 3 frases}}
- **Resultado:** {{N}} casos — {{a}} passou · {{b}} falhou · {{c}} bloqueado · {{d}} não aplicável · {{e}} não validado · {{f}} retratado · {{g}} pendente
- **Número principal medido:** {{ex.: POST /cliente 201 em 7,2 s; KPI foi de 2 para 3 sem F5}}
- **Defeitos:** {{D-NNN (severidade, status)...}} · **Melhorias:** {{...}} · **Pendências:** {{...}}

## Entendimento antes de clicar

- Regras lidas no código: {{obrigatórios, validações, permissões, estados, efeitos a jusante}} — fonte: `{{arquivo:linha}}`
- Oráculos usados: {{código / especificação / regra dita pelo usuário / comportamento anterior}}

## Superfície desta fase

| Item (id no ledger) | O que é | Casos |
|---|---|---|
| `{{tela:/rota}}` | {{descrição}} | {{C-0001..C-0012}} |
| `{{elemento:/rota#botao-salvar}}` | {{descrição; se desabilitado, o motivo e o tooltip}} | {{...}} |

## Testes — entrada → resultado

| Caso | Item | Técnica | Entrada / ação | Esperado (oráculo) | Obtido (medido) | Status | Evidência |
|---|---|---|---|---|---|---|---|
| C-{{0001}} | `{{item}}` | {{valor-limite}} | {{qtd = 50}} | {{bloqueia: "mínimo 51" (regra do usuário)}} | {{bloqueou, 0 requisições}} | passou | {{NN}} |

## Evidências

### {{NN}} — {{título curto}}

![{{NN}} — {{título}}](../evidencias/{{NN-o-que-mostra}}-circulado.png)

*O que o print mostra:* {{valores, códigos, estado de botão, texto exato do erro — não "print da tela"}}.

## Provas de rede e banco

| Chamada | Status | Tempo | Enviado (resumo) | Recebido (resumo) | Arquivo |
|---|---|---|---|---|---|
| `{{POST /api/...}}` | {{201}} | {{7,2 s}} | `{{...}}` | `{{...}}` | `rede/{{NN-chamada}}.json` |

Banco (somente leitura):

```sql
{{consulta}}
```

→ {{resultado, e o que NÃO deveria ter mudado e não mudou}}

## Defeitos

| Id | Severidade | Sintoma | Onde | Status |
|---|---|---|---|---|
| D-{{NNN}} | {{alto}} | {{...}} | `{{arquivo:linha}}` | {{aberto / corrigido / retestado-ok / nao-corrigido}} |

{{Bloco completo de cada defeito, a partir de templates/defeito.md, ou link para ../defeitos/D-NNN.md}}

## Retratações

| Achado | O que parecia | O que era | Como descobri |
|---|---|---|---|
| {{...}} | {{...}} | {{...}} | {{...}} |

## Hipóteses que caíram

- {{hipótese}} — derrubada por {{medição / print / segundo caminho}}.

## Melhorias

| # | Onde | O que melhorar | Por quê | Aplicada (com reteste) ou proposta |
|---|---|---|---|---|
| {{1}} | {{tela/campo}} | {{...}} | {{...}} | {{aplicada, D-NNN retestado-ok / proposta}} |

## Design

- {{o que quebra hierarquia ou consistência, sempre dentro do design system do projeto}}

## Sujeira deixada

| Ambiente | O quê | Identificador | Estado final | Quem limpa / como |
|---|---|---|---|---|
| {{dev}} | {{registro criado}} | {{código}} | {{ativo}} | {{fica; ou: excluir pela tela X}} |

Dados alterados só para o teste passar: {{o quê, de que valor para que valor — ou "nenhum"}}

## Não validado nesta fase

| O quê | Por quê | O que falta |
|---|---|---|
| {{...}} | {{falta o papel X / efeito externo não autorizado / ambiente fora}} | {{...}} |

## Pendências para a próxima fase

- Casos ainda `pendente`: {{ids}}
- Reinício pedido ao usuário: {{não / sim, para validar ...}}

## Registro

- Ledger: {{casos e defeitos atualizados}} · gate da fase: {{saída de scripts/cobertura.py gate}}
- Lição genérica → gravada com `scripts/aprender.py licao` (`references/aprender.md`): {{código e destino, ou "nenhuma"}}
- Lição do projeto → `scripts/aprender.py licao --destino perfil` (`.qa/PERFIL.md`): {{... ou "nenhuma"}}

<!--
Só em notas/10-aprender.md (fase 11; references/aprender.md §5 e §8). O `cobertura.py fechar` procura
as duas perguntas abaixo, uma resposta não vazia para cada (o que estiver entre {{ }} não conta) e ao
menos uma linha que comece por "APRENDI:", "NAO GRAVADA" ou "Nenhuma lição:" com 10 caracteres ou
mais depois. Copie as linhas APRENDI e NAO GRAVADA da saída do aprender.py. Nas outras notas, apague
este bloco.
-->

## O que testei que não estava no catálogo?

{{resposta (ou "nada", com o porquê): o que entrou no plano por exploração, por armadilha do PERFIL ou por pedido do usuário}}

## O que faltou e só percebi depois?

{{resposta (ou "nada", com o porquê): o que o crítico, o reteste ou o usuário mostraram tarde}}

## Lições

- APRENDI: {{código}} — {{regra gravada, copiada da saída do aprender.py}}
- NAO GRAVADA {{código ou assunto}}: {{motivo da recusa}}
- Nenhuma lição: {{porquê, só quando as duas respostas acima são "nada"}}
