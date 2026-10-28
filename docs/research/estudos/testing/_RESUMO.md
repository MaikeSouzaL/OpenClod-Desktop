# Estudos de testing e observabilidade — resumo e prioridades

> Quatro clones analisados estaticamente em `repositorios/_research/testing/`.
> Método: leitura de código, sem instalar dependências e sem rodar os testes dos
> clones. Cada estudo individual tem 13 seções e cita caminho + linha.
> Data da análise: 2026-10-26.

## Veredito por repositório

| Repositório | O que é de fato | Valor para o Openclod | Risco |
|---|---|---|---|
| `promptfoo--promptfoo` | CLI/biblioteca de eval de prompts e agentes, com assertions, tracing OTEL e red team | **Alto**: é o melhor catálogo de assertions de trajetória e de contrato de grading | produto grande; muito código que não usamos |
| `confident-ai--deepeval` | Framework Python de métricas LLM, nativo de pytest | **Alto**: métricas agênticas determinísticas (tools, loop, plano) | stack Python; nuvem proprietária |
| `langfuse--langfuse` | Plataforma de observabilidade LLM (traces, scores, datasets, experimentos) | **Alto como modelo de dados**: taxonomia de spans, uso/custo, score, transcript | infra pesada e pastas `ee/` proprietárias |
| `open-telemetry--opentelemetry-js` | SDK/API de referência do OpenTelemetry | **Alto como dependência**, baixo como código para portar | 3.x acabou de sair; 2.x será suportado por 1 ano |

## Diagnóstico do nosso harness

O que já existe e deve ser reaproveitado:

- `ObservabilityService` grava eventos JSONL + métricas duráveis, com redação,
  rotação e export gzip
  (`src/core/observability/service.ts:16-19,80-92,353-427`).
- Correlação atual: `sessionId`, `turnId` (= `messageId`), `toolCallId`
  (`service.ts:184-291`; `src/shared/types.ts:309-364`).
- Testes de harness já usam `ScriptedProvider` (`tests/runner.test.ts:4,90-105`;
  `src/core/providers/mock.ts:23`).
- `src/core/quality/engine.ts:7-24` define checks de test/typecheck/lint/build;
  a execução está em `runQualityChecks` (`:84-99`), mas **não** avalia qualidade
  de resposta de modelo.

O que falta:

1. **Span**: não há árvore, `parentId`, tipo de span, nem trace ID. Só eventos
   planos.
2. **Custo por turno/ferramenta**: `usage` é agregado global
   (`service.ts:243-249`); não há custo atribuído a um turno ou tool.
3. **Avaliação**: não existe dataset, assertion, juiz LLM, score ou regressão
   de prompt. Não há arquivo em `src/` com `eval|dataset|judge|rubric|score` no
   nome; o termo `evaluation` em `src/core/agent/runner.ts:1370-1409` é decisão
   de permissão, não avaliação de resposta.
4. **Export OTLP**: não existe (`grep` por `otel|traceparent|otlp` em `src/`
   não retorna nada).
5. **Sessão/turno em trace**: o dado existe, mas não vira hierarquia
   observável.

## 12 candidatos priorizados

Score 0–25 = encaixe no harness (0–10) + qualidade/testes (0–5) + robustez de
bordas (0–5) + portabilidade/licença (0–5).

| # | Candidato | Origem (arquivo:linha) | Score | Tipo | Destino proposto |
|---|---|---|---:|---|---|
| 1 | Taxonomia trace/observation + uso/custo "provided" vs. calculado | `langfuse/packages/shared/src/domain/observations.ts:9-33,59-107`; `traces.ts:12-30` | 24 | porta (conceito + tipos) | `src/core/observability/types.ts` |
| 2 | Retry de export OTLP com jitter, deadline e `Retry-After` | `opentelemetry-js/experimental/packages/otlp-exporter-base/src/retrying-transport.ts:10-103` | 24 | dependência | `@opentelemetry/*` (não copiar) |
| 3 | Assertions de trajetória (tool-used, sequência, args, passos) | `promptfoo/src/assertions/trajectory.ts:130-600` | 24 | porta | `src/core/eval/assertions/trajectory.ts` |
| 4 | Correção de tools determinística (exato, LCS, parcial) | `deepeval/metrics/tool_correctness/tool_correctness.py:474-621` | 23 | porta | `src/core/eval/metrics/tool-correctness.ts` |
| 5 | Batch processor com fila limitada, flush e descarte contado | `opentelemetry-js/packages/sdk-trace/src/export/BatchSpanProcessorBase.ts:45-247` | 23 | dependência | `@opentelemetry/sdk-trace` |
| 6 | Mapa de atributos OTLP (`session.id`, `gen_ai.*`, `langfuse.*`) | `langfuse/packages/shared/src/server/otel/attributes.ts:5-44`; `ObservationTypeMapper.ts:256` | 22 | porta/adaptação | `src/core/observability/attributes.ts` |
| 7 | Registry de assertions + contrato `GradingResult` | `promptfoo/src/assertions/index.ts:229-330` | 22 | porta | `src/core/eval/assertions/index.ts` |
| 8 | Detecção de loop de agente (repetição, estagnação, ciclo) | `deepeval/metrics/agent_loop_detection/agent_loop_detection.py:65-258` | 22 | reimplementação | `src/core/eval/metrics/agent-loop.ts` |
| 9 | Validação de `traceparent` (W3C, versões futuras) | `opentelemetry-js/packages/opentelemetry-core/src/trace/W3CTraceContextPropagator.ts:20-53` | 22 | reimplementação | `src/core/observability/traceparent.ts` |
| 10 | Score tipado (numérico/categórico/booleano/correção) | `langfuse/packages/shared/src/domain/scores.ts:47-61` | 21 | porta | `src/core/eval/score.ts` |
| 11 | Contrato de métrica (score/threshold/reason/success/custo/tokens) | `deepeval/metrics/base_metric.py:111-204` | 21 | reimplementação | `src/core/eval/metrics/types.ts` |
| 12 | Juiz LLM com JSON estrito + `scoreExplanation` | `promptfoo/src/prompts/grading.ts:11-30`; `langfuse/.../llmEvaluatorExecution.ts:29-30,99-160` | 21 | porta (prompt + schema) | `src/core/eval/judge.ts` |

### Não priorizados (mas estudados)

| Item | Score | Por que ficou fora do top 12 |
|---|---:|---|
| Correlação `thread_id`/`turn_id` no trace (`deepeval/tracing/types.py:87-201`) | 20 | já temos `sessionId`/`messageId`; falta só mapear |
| Asserts de custo/latência (`promptfoo/src/assertions/cost.ts:3`; `latency.ts:3`) | 20 | barato, mas depende do runner de eval existir |
| Amostragem determinística de avaliação (`langfuse/worker/.../deterministicSampling.ts:4-30`) | 19 | só relevante quando houver volume |
| Transcript por turno (`langfuse/.../transcript/transcript.ts:48-89`) | 19 | útil para o visualizador, não para o MVP de eval |
| Cache de métricas por caso (`deepeval/test_run/cache.py:40-41,139-170`) | 18 | evita custo, mas pode esperar |
| `Golden` como schema de dataset (`deepeval/dataset/golden.py:181-239`) | 18 | bom ponto de partida, ainda sem dataset real |
| Item de dataset run (`langfuse/domain/dataset-run-items.ts:5-27`) | 18 | idem |
| Baseline de experimento (`langfuse/web/.../ExperimentBaselineControls.tsx:27-115`) | 17 | precisa de runs versionados primeiro |
| Precificação por modelo/tier (`langfuse/server/ingestion/modelMatch.ts:45-76`) | 16 | nosso custo já vem do provider; só falta rate card |
| Síntese de dataset (`promptfoo/testCase/synthesis.ts:170-311`) | 16 | gera casos, mas com custo de modelo |
| `MCPTaskCompletionMetric` (`deepeval/metrics/mcp/mcp_task_completion.py:45-131`) | 17 | interessante, porém específico de MCP multi-turn |
| Receiver OTLP (`promptfoo/src/tracing/otlpReceiver.ts:272-520`) | 18 | só faz sentido se aceitarmos traces externos |

## Arquitetura-alvo (mínima e incremental)

```
src/core/observability/
  types.ts        Trace + Span + Usage + Cost (novo)
  attributes.ts   normalização de nomes (novo)
  span-map.ts     HarnessEvent → Span (novo)
  otel.ts         SDK opt-in + BatchSpanProcessor (novo)
  service.ts      JSONL/métricas atuais (manter como fallback)

src/core/eval/
  types.ts        EvalCase, EvalAssertion, EvalResult
  run.ts          executa matriz caso × provider
  assertions/     registry + handlers determinísticos
  metrics/        tool-correctness, agent-loop
  judge.ts        LLM-as-judge com schema Zod
  store.ts        um JSON por run
  compare.ts      run atual × baseline
```

Decisões de projeto:

- **Trace ID = `sessionId`**. Um turno é um span raiz; cada tool é um span
  filho. Isso preserva a correlação que o `ObservabilityService` já faz.
- **JSONL primeiro, OTLP depois**. O exporter é opt-in por env; sem endpoint,
  nada muda no comportamento atual.
- **Nenhum segredo sai**. Redigir no `SpanProcessor` com a mesma função
  `redactDiagnosticText` (`service.ts:80-92`), não no exporter.
- **Dependência, não fork**. OTel entra como pacote; só o mapeamento e a
  redação são nossos.

## O que não vale a pena

| Item | Motivo |
|---|---|
| Copiar o SDK OTel inteiro | ~110k linhas e 248 suítes; usar como dependência |
| Trazer a UI/plataforma do Langfuse | produto inteiro, ClickHouse + Redis + S3 |
| `ee/` do Langfuse | licença Enterprise, incompatível com reuso |
| 50+ métricas do DeepEval | maioria depende de juiz/contexto que não temos |
| Red team do promptfoo | grande e acoplado ao servidor |
| Estrutura pytest / Typer | stack incompatível (nosso runner é TS/Vitest) |
| OTel 2.x (`sdk-trace-node`) | removido no 3.x; código novo deve usar `@opentelemetry/sdk-trace` |
| Nunjucks / Drizzle / libSQL do promptfoo | duplicam o que já temos e trazem risco (SSTI, schema) |

## Ordem de implementação sugerida

1. **Tipos e mapeamento** (`observability/types.ts`, `attributes.ts`,
   `span-map.ts`): impacto alto, sem dependência externa.
2. **OTel opt-in** (`otel.ts`) com `BatchSpanProcessor` 512/2048/5s/30s e
   exporter OTLP/HTTP; teste com `InMemorySpanExporter`.
3. **Eval MVP** (`eval/types.ts`, `eval/run.ts`): matriz caso × provider usando
   `ScriptedProvider` nos testes.
4. **Assertions determinísticas** (registry + igualdade/contains/regex/json,
   custo, latência, tool-used, tool-sequence, step-count).
5. **Métricas de agente** (tool-correctness, agent-loop) sobre `TrajectoryStep`.
6. **Juiz LLM** com schema estrito, orçamento e cache.
7. **Store + compare** (run JSON, baseline, exit code para CI).
8. Só então: receiver OTLP, síntese de dataset e amostragem.

## Licenças e reuso

| Repositório | Licença | Reuso de código | Observação |
|---|---|---|---|
| promptfoo | MIT (`LICENSE:1`) | permitido com aviso | preservar copyright |
| deepeval | Apache-2.0 (`LICENSE.md:1`) | permitido com aviso e NOTICE | verificar NOTICE |
| langfuse | MIT fora de `ee/` (`LICENSE:1-10`) | permitido fora de `ee/` | **não** importar `ee/` |
| opentelemetry-js | Apache-2.0 (`LICENSE:1`) | permitido | preferir dependência |

Nenhum bloqueio legal para portar ideias ou trechos. O risco real é de
**acoplamento**: promptfoo/Langfuse são produtos com banco e UI; DeepEval é
Python. O que devemos copiar é o **contrato de dados** e os **algoritmos
determinísticos**, não a infraestrutura.

## Arquivos produzidos

- `docs/research/estudos/testing/promptfoo--promptfoo.md`
- `docs/research/estudos/testing/confident-ai--deepeval.md`
- `docs/research/estudos/testing/langfuse--langfuse.md`
- `docs/research/estudos/testing/open-telemetry--opentelemetry-js.md`
- `docs/research/estudos/testing/_RESUMO.md`
