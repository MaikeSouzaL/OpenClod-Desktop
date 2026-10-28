# 02 — Riscos

> Documento sintetizado a partir exclusivamente das notas em `notas/produto.txt`, `notas/equipe.txt` e `notas/riscos.txt`.
> Probabilidades e impactos são **transcritos** das notas. Onde as notas não informam, está marcado como "não registrado" em vez de estimado.

## Cenário das notas

- Produto: aplicativo **Horizonte**, para **pequenos varejistas**.
- Lançamento previsto: **15/09/2026**. Data de referência desta consolidação: **27/10/2026**.
- Equipe: 2 desenvolvedores, 1 designer, 1 analista de suporte.
- Orçamento total: **R$ 90.000**.

## Registro de riscos

### Risco 1 — Atraso do fornecedor de pagamentos

| Campo | Valor nas notas |
|---|---|
| Probabilidade | **Alta** |
| Impacto | não registrado |
| Categoria | Dependência externa / cronograma |

**Por que pesa mais aqui:** a cobrança por Pix integrada é o **diferencial do produto**. Um atraso do fornecedor de pagamentos não afeta uma funcionalidade periférica — atinge a proposta de valor central e, por consequência, o marco de lançamento de 15/09/2026.

**Exposição à data de referência:** como 27/10/2026 é posterior à data prevista, este é o risco que primeiro precisa ser checado: ele já se materializou ou não?

**Não registrado nas notas:** identidade do fornecedor, contrato, SLA, plano de contingência, existência de segundo fornecedor.

---

### Risco 2 — Baixa adesão no primeiro mês

| Campo | Valor nas notas |
|---|---|
| Probabilidade | **Média** |
| Impacto | não registrado |
| Categoria | Mercado / produto |

**Por que pesa:** a equipe é enxuta (4 pessoas) e o orçamento é finito. Baixa adesão no primeiro mês comprime a receita justamente na janela em que o time ainda está absorvendo feedback e corrigindo o produto.

**Dependência oculta:** "adesão" só é gerenciável se estiver medida. As notas não definem métrica de sucesso — sem número-alvo (lojistas ativos, volume transacionado, retenção), não há como detectar o risco a tempo nem declarar que ele não ocorreu.

**Não registrado nas notas:** base de usuários esperada, meta de ativação, plano de aquisição, orçamento de marketing.

---

### Risco 3 — Falha de segurança no login

| Campo | Valor nas notas |
|---|---|
| Probabilidade | **Baixa** |
| Impacto | **Alto** |
| Categoria | Segurança / confiança |

**Por que pesa mais do que a probabilidade sugere:** é o único risco com impacto explicitamente alto nas notas. Em produto de pagamentos, falha de autenticação tem efeito desproporcional — expõe dados de lojistas, pode exigir comunicação pública e compromete a confiança no Pix integrado, que é o diferencial de venda.

**Assimetria:** probabilidade baixa × impacto alto é exatamente o perfil que costuma ser subpriorizado por parecer improvável. Vale tratá-lo por prevenção (revisão de autenticação, testes de segurança antes do lançamento) e não por reação.

**Não registrado nas notas:** requisitos de segurança aplicáveis, se há revisão de segurança planejada, tratamento de dados pessoais, plano de resposta a incidentes.

---

## Matriz de priorização

| Risco | Probabilidade | Impacto | Prioridade derivada |
|---|---|---|---|
| 1 — Atraso do fornecedor de pagamentos | Alta | não registrado | **Alta** (probabilidade alta + atinge o diferencial) |
| 3 — Falha de segurança no login | Baixa | Alto | **Alta** (impacto alto, tratável por prevenção) |
| 2 — Baixa adesão no primeiro mês | Média | não registrado | **Média** (depende de definir métrica) |

A coluna "Prioridade derivada" é uma leitura deste documento, não um dado das notas.

## Riscos implícitos no cenário (leitura, não dado das notas)

Itens que decorrem da combinação dos fatos registrados — marcados como interpretação:

1. **Concentração de time.** 2 desenvolvedores para um app com integração de pagamentos e requisitos de segurança. Qualquer ausência (férias, desligamento) tem efeito imediato no cronograma.
2. **Orçamento sem folga declarada.** R$ 90.000 é o total; as notas não registram quanto já foi consumido. Sem essa informação, não é possível saber se há margem para absorver o Risco 1.
3. **Suporte com uma pessoa.** O analista de suporte é único; no primeiro mês, o pico de atendimento coincide com o período de maior fragilidade do produto.
4. **Data-base vencida e sem status.** O lançamento estava previsto para 15/09/2026 e a consolidação é de 27/10/2026. A ausência de status é, por si, um risco de gestão: decisões estão sendo tomadas sobre um plano cuja situação real não está documentada.

## Lacunas que impedem avaliar os riscos por completo

- **Impacto** dos Riscos 1 e 2 (não quantificado nas notas).
- **Status real do cronograma** frente a 15/09/2026.
- **Fornecedor de pagamentos**: nome, contrato, SLA, alternativas.
- **Execução orçamentária**: gasto até agora e saldo.
- **Métricas de sucesso** para o primeiro mês.
- **Plano de segurança** para o login.

O tratamento dessas lacunas está em `03-plano-de-acao.md`.
