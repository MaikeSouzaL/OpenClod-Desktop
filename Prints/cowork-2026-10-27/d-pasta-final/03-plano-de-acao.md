# 03 — Plano de ação

> Construído sobre as notas em `notas/` e sobre `01-visao-geral.md` e `02-riscos.md`.
> As ações abaixo são **propostas deste documento** — nenhuma delas está registrada nas notas. O que vem das notas são os fatos: Horizonte para pequenos varejistas, Pix integrado, lançamento previsto em 15/09/2026, 4 pessoas, R$ 90.000, e os três riscos.

## Premissa que muda todo o plano

A data prevista de lançamento (**15/09/2026**) é anterior à data de referência desta consolidação (**27/10/2026**), e as notas não dizem se o lançamento ocorreu. Portanto a **primeira ação não é executar: é apurar**.

Enquanto esse ponto não estiver claro, qualquer plano de trabalho é construído sobre um cenário suposto.

---

## Fase 0 — Apuração (antes de decidir qualquer coisa)

| # | Ação | Responsável sugerido | Critério de conclusão |
|---|---|---|---|
| 0.1 | Confirmar o status real: lançou, foi remarcado ou está em desenvolvimento? | dono do projeto | uma resposta registrada por escrito |
| 0.2 | Situação do fornecedor de pagamentos: contrato assinado, prazo comprometido, atraso real | dev + dono do projeto | data comprometida documentada |
| 0.3 | Execução orçamentária: quanto dos R$ 90.000 já foi gasto e qual o saldo | dono do projeto | número de gasto e saldo |
| 0.4 | Definir a métrica de "adesão" do primeiro mês (lojistas ativos, volume transacionado, retenção) | dono do projeto + designer | métrica com número-alvo |
| 0.5 | Levantar requisitos de segurança aplicáveis ao login e ao Pix | devs | lista de requisitos acordada |

**Por que a Fase 0 vem primeiro:** os Riscos 1 e 2 não têm impacto quantificado e o status do cronograma é desconhecido. Sem 0.1–0.5, as fases seguintes viram suposição.

---

## Fase 1 — Proteger o diferencial (Risco 1)

O Pix integrado é o diferencial declarado do produto; o atraso do fornecedor é o risco de probabilidade **alta**.

| # | Ação | Critério de conclusão |
|---|---|---|
| 1.1 | Formalizar por escrito o prazo do fornecedor (contrato ou e-mail com data) | data comprometida em mãos |
| 1.2 | Mapear um caminho alternativo de cobrança para o caso de atraso | alternativa mínima viável descrita |
| 1.3 | Isolar a integração de pagamentos atrás de uma camada de abstração no código | troca de provedor sem reescrever o app |
| 1.4 | Definir a data de decisão: até quando esperar o fornecedor antes de acionar a alternativa | data-limite registrada |

**1.3 é a ação de maior retorno:** com 2 desenvolvedores, uma reescrita causada por troca de fornecedor é o pior cenário possível para o cronograma.

---

## Fase 2 — Blindar o login (Risco 3)

Probabilidade **baixa**, impacto **alto**: tratar por prevenção, não por reação.

| # | Ação | Critério de conclusão |
|---|---|---|
| 2.1 | Revisão de autenticação: hashing de senha, política de sessão, expiração de token | achados listados e corrigidos |
| 2.2 | Teste de segurança antes da exposição pública | relatório de teste anexado |
| 2.3 | Plano de resposta a incidente (quem avisa, em quanto tempo, como comunicar) | documento de uma página |
| 2.4 | Limitar escopo dos dados pessoais coletados | lista de dados efetivamente necessários |

Não substitui 0.5: os requisitos vêm de lá; a execução fica aqui.

---

## Fase 3 — Medir a adesão desde o dia um (Risco 2)

| # | Ação | Critério de conclusão |
|---|---|---|
| 3.1 | Instrumentar a métrica definida em 0.4 antes do lançamento | painel com o número do primeiro mês |
| 3.2 | Definir a leitura de 30 dias: qual valor indica sucesso, atenção e fracasso | três faixas numéricas registradas |
| 3.3 | Preparar resposta rápida para o pico de suporte do primeiro mês | fila de atendimento e respostas prontas |

O analista de suporte é **um só**. O pico do primeiro mês coincide com a fase mais frágil do produto — 3.3 não é conforto, é capacidade.

---

## Fase 4 — Execução e proteção do time

| # | Ação | Critério de conclusão |
|---|---|---|
| 4.1 | Reservar parte do orçamento como contingência (sugestão: 15–20%), condicionada a 0.3 | valor de reserva definido |
| 4.2 | Registrar o plano em marcos com datas, não em uma data única de lançamento | cronograma com marcos |
| 4.3 | Revisar riscos a cada marco, atualizando probabilidades com dado real | registro de revisão |

Com **2 desenvolvedores**, a proteção mais eficaz é não ter duas frentes críticas em paralelo. Se 1.3 e 2.1 competirem pelo mesmo par de pessoas, uma delas espera — e a escolha depende do resultado de 0.1.

---

## Sequência recomendada

```
Fase 0 (apuração)  →  decide o resto
   ├─ se já lançou  →  Fase 3 (medir adesão) + Fase 2 (segurança) imediatas
   ├─ se remarcado  →  Fase 1 (fornecedor) + Fase 2 (login) antes da nova data
   └─ se em curso    →  Fase 1.3 (abstração do pagamento) antes de tudo
```

A ramificação existe porque o resultado de 0.1 muda a ordem — não porque o plano é indeciso.

---

## O que este plano não faz

- **Não define a nova data de lançamento.** Isso depende de 0.1 e 0.2 e é decisão do dono do projeto, não deste documento.
- **Não quantifica impacto dos Riscos 1 e 2.** Depende de 0.2, 0.3 e 0.4.
- **Não propõe contratação.** As notas registram 4 pessoas e R$ 90.000; contratar é uma decisão de negócio que exige o saldo de 0.3.

## Resumo executivo

Cinco apurações na Fase 0 destravam todo o resto. Em seguida, três frentes protegidas — fornecedor de pagamentos (probabilidade alta, atinge o diferencial), login (impacto alto, prevenção barata) e medição de adesão (sem métrica, o Risco 2 é invisível) — com o orçamento mantendo reserva declarada. A ordem entre as frentes é resultado de 0.1, não uma escolha arbitrária.
